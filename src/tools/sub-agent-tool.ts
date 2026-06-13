import type OpenAI from "openai";
import { BaseTool, ToolRegistry, type ToolParam } from "./basetool.js";
import type { Agent } from "../agent/agent.js";
import { runAgentTask, type AgentTaskResult } from "../agent/agent-task.js";
import { MessageQueue } from "../agent/message-queue.js";
import { EventLoop } from "../agent/event-loop.js";
import {
    buildAgentIdentity,
    buildInitialMessages,
    buildOrderedPromptMessages,
} from "../agent/prompts.js";
import { AgentEventType } from "../agent/events.js";
import type {
    AgentEvent,
    SubAgentStartEvent,
    SubAgentProgressEvent,
    SubAgentCompleteEvent,
    SubAgentErrorEvent,
    SubAgentResultReadyEvent,
} from "../agent/events.js";

export interface PendingSubAgentResult {
    subAgentId: string;
    subAgentName?: string;
    task: string;
    finalContent: string;
    elapsedMs: number;
    completedAt: number;
}

const pendingResults: PendingSubAgentResult[] = [];

export function pushPendingResult(result: PendingSubAgentResult): void {
    pendingResults.push(result);
}

export function drainPendingResults(): PendingSubAgentResult[] {
    if (pendingResults.length === 0) return [];
    const results = [...pendingResults];
    pendingResults.length = 0;
    return results;
}

export function hasPendingResults(): boolean {
    return pendingResults.length > 0;
}

interface SubAgentEntry {
    promise: Promise<AgentTaskResult> | null;
    status: "running" | "completed" | "failed";
    subAgentId: string;
    startedAt: number;
    task: string;
    subAgentName: string;
    parentTurnId: string;
    parentAgentName: string;
    model?: string;
    allowedTools: string[];
    context: OpenAI.Chat.ChatCompletionMessageParam[];
    registry: ToolRegistry;
    bus: MessageQueue;
    loop: EventLoop;
    parentBus: MessageQueue;
    persistent: boolean;
    result?: AgentTaskResult;
    error?: string;
}

const subAgentStore = new Map<string, SubAgentEntry>();
const subAgentNameIndex = new Map<string, string>();

const DEFAULT_SUBAGENT_BASE_TOOLS = [
    "read_file_symbols",
    "read_file_lines",
    "calculator",
    "get_current_time",
];

const FILE_EDIT_TOOLS = ["file_operator", "memory", "compress"];
const SHELL_TOOLS = ["execute_command"];
const DATABASE_TOOLS = ["db_read"];
const DELEGATION_TOOLS = ["delegate_task"];

function generateSubAgentId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugifySubAgentName(input: string): string {
    const normalized = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "sub-agent";
}

function buildSubAgentName(task: string, requestedName?: string): string {
    if (requestedName?.trim()) {
        return slugifySubAgentName(requestedName);
    }

    const firstLine = task
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "sub-agent";
    return slugifySubAgentName(firstLine.slice(0, 24));
}

function ensureUniqueSubAgentName(baseName: string): string {
    if (!subAgentNameIndex.has(baseName)) {
        return baseName;
    }

    let counter = 2;
    while (subAgentNameIndex.has(`${baseName}-${counter}`)) {
        counter += 1;
    }
    return `${baseName}-${counter}`;
}

export function listSubAgents(): Array<{
    subAgentId: string;
    subAgentName: string;
    status: SubAgentEntry["status"];
    task: string;
    startedAt: number;
}> {
    return [...subAgentStore.entries()].map(([subAgentId, entry]) => ({
        subAgentId,
        subAgentName: entry.subAgentName,
        status: entry.status,
        task: entry.task,
        startedAt: entry.startedAt,
    }));
}

export function findSubAgentByName(name: string): SubAgentEntry | null {
    const normalized = slugifySubAgentName(name);
    const subAgentId = subAgentNameIndex.get(normalized);
    if (!subAgentId) return null;
    return subAgentStore.get(subAgentId) ?? null;
}

async function shutdownSubAgentRuntime(entry: SubAgentEntry): Promise<void> {
    if (entry.persistent) {
        return;
    }
    if (entry.loop.isRunning) {
        await entry.loop.stop().catch(() => {});
    }
    if (!entry.bus.isClosed) {
        entry.bus.close();
    }
}

export async function sendMessageToSubAgent(
    name: string,
    message: string,
    options?: {
        parentTurnId?: string;
        onProgress?: (chunk: string) => void;
    },
): Promise<AgentTaskResult> {
    const entry = findSubAgentByName(name);
    if (!entry) {
        throw new Error(`未找到名为 @${name} 的子 Agent`);
    }

    if (entry.status === "running") {
        throw new Error(`子 Agent @${entry.subAgentName} 当前仍在执行上一轮任务`);
    }

    const parentTurnId = options?.parentTurnId ?? `turn_${Date.now()}`;
    entry.status = "running";
    delete entry.error;
    entry.parentTurnId = parentTurnId;
    entry.task = message;

    const followupIdentity = buildAgentIdentity(
        `SubAgent ${entry.subAgentName} - 你是 "${entry.subAgentName}"，是 "${entry.parentAgentName}" 的命名子 Agent。用户正在通过 @${entry.subAgentName} 直接与你对话。`,
    );

    if (entry.context.length === 0) {
        entry.context.push(...buildInitialMessages(followupIdentity));
    }
    entry.context.push({ role: "user", content: message });

    const promise = runAgentTask({
        registry: entry.registry,
        bus: entry.bus,
        context: entry.context,
        turnId: entry.subAgentId,
        confirmFn: async () => ({ approved: true }),
        emitTokenEvents: false,
        emitStreamingEvents: true,
        emitTokenStats: false,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
    });
    entry.promise = promise;

    const startEvent: SubAgentStartEvent = {
        type: AgentEventType.SUB_AGENT_START,
        subAgentId: entry.subAgentId,
        subAgentName: entry.subAgentName,
        parentTurnId,
        task: message.slice(0, 200),
        model: entry.model ?? "default",
        allowedTools: entry.allowedTools,
    };
    entry.parentBus.enqueue(startEvent);
    options?.onProgress?.(`[子Agent ${entry.subAgentName}] 收到消息: ${message.slice(0, 80)}`);

    try {
        const result = await promise;
        entry.status = "completed";
        entry.result = result;

        const completeEvent: SubAgentCompleteEvent = {
            type: AgentEventType.SUB_AGENT_COMPLETE,
            subAgentId: entry.subAgentId,
            subAgentName: entry.subAgentName,
            parentTurnId,
            task: message.slice(0, 200),
            finalContent: result.finalContent,
            totalToolCalls: result.totalToolCalls,
            totalLlmCalls: result.totalLlmCalls,
            elapsedMs: result.elapsedMs,
        };
        entry.parentBus.enqueue(completeEvent);

        const readyEvent: SubAgentResultReadyEvent = {
            type: AgentEventType.SUB_AGENT_RESULT_READY,
            subAgentId: entry.subAgentId,
            subAgentName: entry.subAgentName,
            parentTurnId,
            task: message.slice(0, 200),
            finalContent: result.finalContent,
            elapsedMs: result.elapsedMs,
        };
        entry.parentBus.enqueue(readyEvent);

        pushPendingResult({
            subAgentId: entry.subAgentId,
            subAgentName: entry.subAgentName,
            task: message,
            finalContent: result.finalContent,
            elapsedMs: result.elapsedMs,
            completedAt: Date.now(),
        });
        await shutdownSubAgentRuntime(entry);
        return result;
    } catch (error) {
        entry.status = "failed";
        entry.error = error instanceof Error ? error.message : String(error);
        const errorEvent: SubAgentErrorEvent = {
            type: AgentEventType.SUB_AGENT_ERROR,
            subAgentId: entry.subAgentId,
            subAgentName: entry.subAgentName,
            parentTurnId,
            task: message.slice(0, 200),
            error: entry.error,
        };
        entry.parentBus.enqueue(errorEvent);
        await shutdownSubAgentRuntime(entry);
        throw error;
    }
}

function inferAllowedTools(task: string, extraContext?: string): string[] {
    const text = `${task}\n${extraContext ?? ""}`.toLowerCase();
    const allowed = new Set<string>(DEFAULT_SUBAGENT_BASE_TOOLS);

    const needsEditing =
        /(edit|modify|change|update|patch|write|rewrite|create|fix|refactor|实现|修改|编写|新增|修复)/.test(
            text,
        );
    const needsShell =
        /(shell|command|terminal|powershell|bash|npm|node|git|tsc|build|run|test|启动|执行命令|终端)/.test(
            text,
        );
    const needsDatabase =
        /(sqlite|database|db|sql|query|select|表|数据库)/.test(text);
    const needsMemory =
        /(memory|history|user\.md|memory\.md|记忆|偏好|历史)/.test(text);
    const needsDelegation =
        /(delegate|sub-?agent|子 agent|委派)/.test(text);

    if (needsEditing) {
        for (const tool of FILE_EDIT_TOOLS) allowed.add(tool);
    }
    if (needsShell) {
        for (const tool of SHELL_TOOLS) allowed.add(tool);
    }
    if (needsDatabase) {
        for (const tool of DATABASE_TOOLS) allowed.add(tool);
    }
    if (needsMemory) {
        allowed.add("memory");
        allowed.add("compress");
    }
    if (needsDelegation) {
        for (const tool of DELEGATION_TOOLS) allowed.add(tool);
    }

    return [...allowed];
}

export class SubAgentTool extends BaseTool {
    name = "delegate_task";

    description = [
        "将任务委派给一个独立的子 Agent 执行（A2A 协议，事件驱动）。",
        "",
        "使用场景：",
        "- 将复杂任务拆解为多个独立子任务并行处理",
        "- 用不同的模型或受限的工具集执行特定子任务",
        "- 在后台执行长时间运行的任务，结果自动推送回主 Agent",
        "",
        "操作模式：",
        "- wait=true（默认）：等待子 Agent 完成，直接返回结果",
        "- wait=false：后台运行，子 Agent 完成后自动推送结果到消息队列",
        "  主 Agent 下一轮对话时会自动看到后台子 Agent 的结果（被动注入上下文）",
        "- action='drain_results'：主动排出并查看已完成后台子 Agent 的结果",
        "  （消费已推送的事件，不是轮询子 Agent 状态）",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "task",
            type: "string",
            description: "子 Agent 的任务描述。action='delegate' 时必填。",
            required: false,
        },
        {
            name: "action",
            type: "string",
            description:
                "操作：'delegate'（spawn 子 Agent，默认）、'drain_results'（排出已推送的后台结果）",
            required: false,
            enum: ["delegate", "drain_results"],
        },
        {
            name: "model",
            type: "string",
            description: "子 Agent 使用的模型名。不填则使用当前模型。",
            required: false,
        },
        {
            name: "allowed_tools",
            type: "string",
            description:
                "逗号分隔的允许工具名列表。不填则按任务内容推断最小必要工具集。",
            required: false,
        },
        {
            name: "context",
            type: "string",
            description: "附加给子 Agent 的上下文或指令（注入到系统提示词）。",
            required: false,
        },
        {
            name: "wait",
            type: "boolean",
            description:
                "是否等待子 Agent 完成。true=等待结果（默认），false=后台运行并推送结果。",
            required: false,
        },
        {
            name: "name",
            type: "string",
            description: "为子 Agent 指定一个名称，供 UI 展示和后续 @name 对话使用。",
            required: false,
        },
    ];

    private parentRegistry: ToolRegistry | null = null;
    private parentBus: MessageQueue | null = null;
    private parentAgentName = "main";

    onInit(agent: Agent): void {
        this.parentRegistry = agent.registry;
        this.parentBus = agent.bus;
        this.parentAgentName = agent.name;
    }

    async execute(
        args: Record<string, unknown>,
        onProgress?: (chunk: string) => void,
    ): Promise<string> {
        const action = (args["action"] as string | undefined) ?? "delegate";

        if (action === "drain_results") {
            const results = drainPendingResults();
            if (results.length === 0) {
                return "没有待处理的后台子 Agent 结果。";
            }

            const parts: string[] = [`已排出 ${results.length} 个后台子 Agent 结果：`, ""];
            for (const r of results) {
                parts.push(
                    `## 子 Agent ${r.subAgentId}`,
                    `任务: ${r.task.slice(0, 200)}`,
                    `耗时: ${(r.elapsedMs / 1000).toFixed(1)}s`,
                    `结果: ${r.finalContent.slice(0, 500)}`,
                    "",
                );
            }
            return parts.join("\n");
        }

        const task = args["task"] as string | undefined;
        if (!task || !task.trim()) {
            return "错误：action='delegate' 需要提供非空的 task 参数。";
        }

        const wait = (args["wait"] as boolean | undefined) ?? true;
        const model = args["model"] as string | undefined;
        const requestedName = args["name"] as string | undefined;
        const contextParam = args["context"] as string | undefined;
        const allowedToolsRaw = args["allowed_tools"] as string | undefined;
        const allowedToolsList = allowedToolsRaw
            ? allowedToolsRaw
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
            : inferAllowedTools(task, contextParam);

        if (!this.parentRegistry) {
            return "错误：子 Agent 工具尚未初始化（parentRegistry 为空）。";
        }
        if (!this.parentBus) {
            return "错误：子 Agent 工具尚未初始化（parentBus 为空）。";
        }

        const filteredRegistry =
            this.parentRegistry.createFiltered(allowedToolsList);
        const subAgentId = generateSubAgentId();
        const subAgentName = ensureUniqueSubAgentName(
            buildSubAgentName(task, requestedName),
        );
        const parentTurnId = `turn_${Date.now()}`;
        const internalBus = new MessageQueue({ maxSize: 256 });
        const internalLoop = new EventLoop(internalBus);
        internalLoop.start();
        const context = this.buildSubAgentContext(
            subAgentName,
            task,
            contextParam,
        );

        this.bridgeEvents(
            internalBus,
            this.parentBus,
            subAgentId,
            subAgentName,
            parentTurnId,
            task,
            model ?? "default",
            allowedToolsList,
            onProgress,
        );

        const autoConfirm = async () => ({ approved: true }) as const;

        const entry: SubAgentEntry = {
            promise: null,
            status: "running",
            subAgentId,
            startedAt: Date.now(),
            task,
            subAgentName,
            parentTurnId,
            parentAgentName: this.parentAgentName,
            allowedTools: allowedToolsList,
            context,
            registry: filteredRegistry,
            bus: internalBus,
            loop: internalLoop,
            parentBus: this.parentBus,
            persistent: true,
            ...(model !== undefined ? { model } : {}),
        };
        subAgentStore.set(subAgentId, entry);
        subAgentNameIndex.set(subAgentName, subAgentId);

        const startEvent: SubAgentStartEvent = {
            type: AgentEventType.SUB_AGENT_START,
            subAgentId,
            subAgentName,
            parentTurnId,
            task: task.slice(0, 200),
            model: model ?? "default",
            allowedTools: allowedToolsList,
        };
        this.parentBus.enqueue(startEvent);

        const taskPromise = runAgentTask({
            registry: filteredRegistry,
            bus: internalBus,
            context,
            turnId: subAgentId,
            confirmFn: autoConfirm,
            emitTokenEvents: false,
            emitStreamingEvents: true,
            emitTokenStats: false,
            ...(model !== undefined ? { model } : {}),
        });
        entry.promise = taskPromise;

        if (wait) {
            try {
                const result = await taskPromise;
                entry.status = "completed";
                entry.result = result;

                const completeEvent: SubAgentCompleteEvent = {
                    type: AgentEventType.SUB_AGENT_COMPLETE,
                    subAgentId,
                    subAgentName,
                    parentTurnId,
                    task: task.slice(0, 200),
                    finalContent: result.finalContent,
                    totalToolCalls: result.totalToolCalls,
                    totalLlmCalls: result.totalLlmCalls,
                    elapsedMs: result.elapsedMs,
                };
                this.parentBus.enqueue(completeEvent);

                return [
                    `子 Agent @${subAgentName} 任务完成`,
                    "",
                    `耗时: ${(result.elapsedMs / 1000).toFixed(1)}s`,
                    `LLM 调用次数: ${result.totalLlmCalls}`,
                    `工具调用次数: ${result.totalToolCalls}`,
                    "",
                    "## 结果",
                    result.finalContent,
                ].join("\n");
            } catch (error) {
                const errMsg =
                    error instanceof Error ? error.message : String(error);
                entry.status = "failed";
                entry.error = errMsg;

                const errorEvent: SubAgentErrorEvent = {
                    type: AgentEventType.SUB_AGENT_ERROR,
                    subAgentId,
                    subAgentName,
                    parentTurnId,
                    task: task.slice(0, 200),
                    error: errMsg,
                };
                this.parentBus.enqueue(errorEvent);

                return `子 Agent 执行失败: ${errMsg}`;
            }
        }

        taskPromise
            .then((result) => {
                entry.status = "completed";
                entry.result = result;

                const completeEvent: SubAgentCompleteEvent = {
                    type: AgentEventType.SUB_AGENT_COMPLETE,
                    subAgentId,
                    subAgentName,
                    parentTurnId,
                    task: task.slice(0, 200),
                    finalContent: result.finalContent,
                    totalToolCalls: result.totalToolCalls,
                    totalLlmCalls: result.totalLlmCalls,
                    elapsedMs: result.elapsedMs,
                };
                this.parentBus?.enqueue(completeEvent);

                const readyEvent: SubAgentResultReadyEvent = {
                    type: AgentEventType.SUB_AGENT_RESULT_READY,
                    subAgentId,
                    subAgentName,
                    parentTurnId,
                    task: task.slice(0, 200),
                    finalContent: result.finalContent,
                    elapsedMs: result.elapsedMs,
                };
                this.parentBus?.enqueue(readyEvent);
                void shutdownSubAgentRuntime(entry);
            })
            .catch((err) => {
                entry.status = "failed";
                entry.error = err instanceof Error ? err.message : String(err);

                const errorEvent: SubAgentErrorEvent = {
                    type: AgentEventType.SUB_AGENT_ERROR,
                    subAgentId,
                    subAgentName,
                    parentTurnId,
                    task: task.slice(0, 200),
                    error: entry.error,
                };
                this.parentBus?.enqueue(errorEvent);
                void shutdownSubAgentRuntime(entry);
            });

        return JSON.stringify(
            {
                sub_agent_id: subAgentId,
                sub_agent_name: subAgentName,
                status: "running",
                allowed_tools: allowedToolsList,
                message:
                    `子 Agent @${subAgentName} 已在后台启动。完成后结果会自动推送到主 Agent 的消息队列。`,
            },
            null,
            2,
        );
    }

    private bridgeEvents(
        internalBus: MessageQueue,
        parentBus: MessageQueue,
        subAgentId: string,
        subAgentName: string,
        parentTurnId: string,
        task: string,
        _model: string,
        _allowedTools: string[],
        onProgress?: (chunk: string) => void,
    ): void {
        const relayEvent = (event: AgentEvent): void => {
            const relayed = {
                ...event,
                turnId: subAgentId,
                subAgentId,
                subAgentName,
                parentTurnId,
                task: task.slice(0, 200),
            } as unknown as AgentEvent;
            parentBus.enqueue(relayed);
        };

        internalBus.subscribe(AgentEventType.TASK_START, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.TASK_STEP, (event) => {
            if (event.type === AgentEventType.TASK_STEP) {
                relayEvent(event);
                const progressEvent: SubAgentProgressEvent = {
                    type: AgentEventType.SUB_AGENT_PROGRESS,
                    subAgentId,
                    subAgentName,
                    parentTurnId,
                    task: task.slice(0, 200),
                    message: event.action,
                };
                parentBus.enqueue(progressEvent);
                onProgress?.(`[子Agent ${subAgentName}] ${event.action}`);
            }
        });

        internalBus.subscribe(AgentEventType.STREAM_THINKING, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.STREAM_ANSWER, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.TOOL_EXECUTION_START, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.TOOL_PROGRESS, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.TOOL_EXECUTION_COMPLETE, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.TOOL_ERROR, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.TASK_COMPLETE, (event) => {
            relayEvent(event as AgentEvent);
        });

        internalBus.subscribe(AgentEventType.TASK_ERROR, (event) => {
            if (event.type === AgentEventType.TASK_ERROR) {
                relayEvent(event);
                const errorEvent: SubAgentErrorEvent = {
                    type: AgentEventType.SUB_AGENT_ERROR,
                    subAgentId,
                    subAgentName,
                    parentTurnId,
                    task: task.slice(0, 200),
                    error: event.error,
                };
                parentBus.enqueue(errorEvent);
                onProgress?.(`[子Agent ${subAgentName}] 失败: ${event.error}`);
            }
        });
    }

    private buildSubAgentContext(
        subAgentName: string,
        task: string,
        extraContext?: string,
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const identity = buildAgentIdentity(
            `SubAgent ${subAgentName} - 一个专门执行委派任务的独立子 Agent。仅使用提供的工具完成任务，完成后返回结果。你是 "${this.parentAgentName}" 的子 Agent，通过 A2A 协议通信。`,
        );

        return buildOrderedPromptMessages({
            identity,
            includeUserPreferences: false,
            includeSystemSettings: false,
            extraSystemMessages:
                extraContext && extraContext.trim()
                    ? [`[子 Agent 额外指令]\n${extraContext}`]
                    : [],
            userQuery: task,
        });
    }
}
