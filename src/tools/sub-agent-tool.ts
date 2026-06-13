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
    UserQueryEvent,
    SubAgentStartEvent,
    SubAgentProgressEvent,
    SubAgentCompleteEvent,
    SubAgentErrorEvent,
    SubAgentResultReadyEvent,
} from "../agent/events.js";
import {
    createA2ARequest,
    createAgentMessageEnvelope,
    type A2AAgentDescriptor,
    type A2ARequest,
} from "../agent/a2a-protocol.js";

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

interface RelayContext {
    subAgentId: string;
    subAgentName: string;
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
    persistent: boolean;
    model?: string;
    allowedTools: string[];
}> {
    return [...subAgentStore.entries()].map(([subAgentId, entry]) => ({
        subAgentId,
        subAgentName: entry.subAgentName,
        status: entry.status,
        task: entry.task,
        startedAt: entry.startedAt,
        persistent: entry.persistent,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        allowedTools: [...entry.allowedTools],
    }));
}

export function findSubAgentByName(name: string): SubAgentEntry | null {
    const normalized = slugifySubAgentName(name);
    const subAgentId = subAgentNameIndex.get(normalized);
    if (!subAgentId) return null;
    return subAgentStore.get(subAgentId) ?? null;
}

export function findSubAgentById(subAgentId: string): SubAgentEntry | null {
    return subAgentStore.get(subAgentId) ?? null;
}

export function getSubAgent(identifier: string): SubAgentEntry | null {
    return findSubAgentById(identifier) ?? findSubAgentByName(identifier);
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

async function disposeSubAgentRuntime(entry: SubAgentEntry): Promise<void> {
    if (entry.loop.isRunning) {
        await entry.loop.stop().catch(() => {});
    }
    if (!entry.bus.isClosed) {
        entry.bus.close();
    }
}

export async function deleteSubAgent(identifier: string): Promise<boolean> {
    const entry = getSubAgent(identifier);
    if (!entry) {
        return false;
    }

    await disposeSubAgentRuntime(entry);
    subAgentStore.delete(entry.subAgentId);
    subAgentNameIndex.delete(entry.subAgentName);
    return true;
}

function buildRelayContext(entry: SubAgentEntry): RelayContext {
    return {
        subAgentId: entry.subAgentId,
        subAgentName: entry.subAgentName,
    };
}

function toAgentDescriptor(entry: SubAgentEntry): A2AAgentDescriptor {
    return {
        agentId: entry.subAgentId,
        agentName: entry.subAgentName,
        persistent: entry.persistent,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        allowedTools: [...entry.allowedTools],
    };
}

function buildSubAgentRequest(
    entry: SubAgentEntry,
    operation: A2ARequest["operation"],
    options: {
        message?: string;
        context?: string;
    } = {},
): A2ARequest {
    return createA2ARequest({
        operation,
        sourceAgentId: entry.parentAgentName,
        sourceAgentName: entry.parentAgentName,
        targetAgentId: entry.subAgentId,
        targetAgentName: entry.subAgentName,
        ...(options.message ? { message: options.message } : {}),
        ...(options.context ? { context: options.context } : {}),
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        allowedTools: [...entry.allowedTools],
    });
}

async function runSubAgentTask(
    entry: SubAgentEntry,
    options?: {
        onProgress?: (chunk: string) => void;
    },
): Promise<AgentTaskResult> {
    const relayContext = buildRelayContext(entry);
    entry.status = "running";
    delete entry.error;
    thisBridgeEvents(entry, relayContext, options?.onProgress);

    const startEvent: SubAgentStartEvent = {
        type: AgentEventType.SUB_AGENT_START,
        subAgentId: entry.subAgentId,
        subAgentName: entry.subAgentName,
        parentTurnId: entry.parentTurnId,
        task: entry.task.slice(0, 200),
        model: entry.model ?? "default",
        allowedTools: entry.allowedTools,
    };
    entry.parentBus.enqueue(startEvent);

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

    try {
        const result = await promise;
        entry.status = "completed";
        entry.result = result;

        const completeEvent: SubAgentCompleteEvent = {
            type: AgentEventType.SUB_AGENT_COMPLETE,
            subAgentId: entry.subAgentId,
            subAgentName: entry.subAgentName,
            parentTurnId: entry.parentTurnId,
            task: entry.task.slice(0, 200),
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
            parentTurnId: entry.parentTurnId,
            task: entry.task.slice(0, 200),
            finalContent: result.finalContent,
            elapsedMs: result.elapsedMs,
        };
        entry.parentBus.enqueue(readyEvent);

        pushPendingResult({
            subAgentId: entry.subAgentId,
            subAgentName: entry.subAgentName,
            task: entry.task,
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
            parentTurnId: entry.parentTurnId,
            task: entry.task.slice(0, 200),
            error: entry.error,
        };
        entry.parentBus.enqueue(errorEvent);
        await shutdownSubAgentRuntime(entry);
        throw error;
    }
}

function thisBridgeEvents(
    entry: SubAgentEntry,
    relayContext: RelayContext,
    onProgress?: (chunk: string) => void,
): void {
    if ((entry.bus as unknown as { __relayBound?: boolean }).__relayBound) {
        return;
    }
    (entry.bus as unknown as { __relayBound?: boolean }).__relayBound = true;

    const relayEvent = (event: AgentEvent): void => {
        const relayed = {
            ...event,
            turnId: relayContext.subAgentId,
            subAgentId: relayContext.subAgentId,
            subAgentName: relayContext.subAgentName,
            parentTurnId: entry.parentTurnId,
            task: entry.task.slice(0, 200),
        } as unknown as AgentEvent;
        entry.parentBus.enqueue(relayed);
    };

    entry.bus.subscribe(AgentEventType.TASK_START, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.TASK_STEP, (event) => {
        if (event.type === AgentEventType.TASK_STEP) {
            relayEvent(event);
            const progressEvent: SubAgentProgressEvent = {
                type: AgentEventType.SUB_AGENT_PROGRESS,
                subAgentId: relayContext.subAgentId,
                subAgentName: relayContext.subAgentName,
                parentTurnId: entry.parentTurnId,
                task: entry.task.slice(0, 200),
                message: event.action,
            };
            entry.parentBus.enqueue(progressEvent);
            onProgress?.(`[子Agent ${relayContext.subAgentName}] ${event.action}`);
        }
    });

    entry.bus.subscribe(AgentEventType.STREAM_THINKING, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.STREAM_ANSWER, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.TOOL_EXECUTION_START, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.TOOL_PROGRESS, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.TOOL_EXECUTION_COMPLETE, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.TOOL_ERROR, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.TASK_COMPLETE, (event) => {
        relayEvent(event as AgentEvent);
    });

    entry.bus.subscribe(AgentEventType.TASK_ERROR, (event) => {
        if (event.type === AgentEventType.TASK_ERROR) {
            relayEvent(event);
            const errorEvent: SubAgentErrorEvent = {
                type: AgentEventType.SUB_AGENT_ERROR,
                subAgentId: relayContext.subAgentId,
                subAgentName: relayContext.subAgentName,
                parentTurnId: entry.parentTurnId,
                task: entry.task.slice(0, 200),
                error: event.error,
            };
            entry.parentBus.enqueue(errorEvent);
            onProgress?.(`[子Agent ${relayContext.subAgentName}] 失败: ${event.error}`);
        }
    });
}

export async function sendMessageToSubAgent(
    name: string,
    message: string,
    options?: {
        parentTurnId?: string;
        onProgress?: (chunk: string) => void;
        sourceAgentId?: string;
        sourceAgentName?: string;
        channel?: "direct" | "a2a";
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
    const sourceAgentId = options?.sourceAgentId ?? "user";
    const sourceAgentName = options?.sourceAgentName ?? "user";
    const channel = options?.channel ?? "direct";
    const contextualMessage =
        channel === "a2a" && sourceAgentId !== "user"
            ? `[A2A 来自 ${sourceAgentName}]\n${message}`
            : message;

    const envelope = createAgentMessageEnvelope({
        conversationId: entry.subAgentId,
        turnId: parentTurnId,
        sourceAgentId,
        sourceAgentName,
        targetAgentId: entry.subAgentId,
        targetAgentName: entry.subAgentName,
        role: sourceAgentId === "user" ? "user" : "agent",
        channel,
        content: contextualMessage,
    });
    const queryEvent: UserQueryEvent = {
        type: AgentEventType.USER_QUERY,
        turnId: parentTurnId,
        query: contextualMessage,
        timestamp: envelope.timestamp,
    };
    entry.parentBus.enqueue({
        ...queryEvent,
        subAgentId: entry.subAgentId,
        subAgentName: entry.subAgentName,
        message: envelope,
    } as unknown as AgentEvent);
    (entry as unknown as { lastEnvelope?: ReturnType<typeof createAgentMessageEnvelope> }).lastEnvelope = envelope;
    entry.context[entry.context.length - 1] = {
        role: "user",
        content: contextualMessage,
    };
    options?.onProgress?.(`[子Agent ${entry.subAgentName}] 收到消息: ${contextualMessage.slice(0, 80)}`);
    return runSubAgentTask(entry, options);
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
                "操作：'delegate'（创建并执行，默认）、'send'（向已有子 Agent 发送消息）、'drain_results'、'list'、'delete'",
            required: false,
            enum: ["delegate", "send", "drain_results", "list", "delete"],
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

        if (action === "list") {
            const agents = listSubAgents();
            if (agents.length === 0) {
                return "当前没有已注册的子 Agent。";
            }
            return JSON.stringify(
                {
                    agents: agents.map((agent) => ({
                        sub_agent_id: agent.subAgentId,
                        sub_agent_name: agent.subAgentName,
                        status: agent.status,
                        task: agent.task,
                        persistent: agent.persistent,
                        model: agent.model ?? "default",
                        allowed_tools: agent.allowedTools,
                    })),
                },
                null,
                2,
            );
        }

        if (action === "send") {
            const identifier = (args["name"] as string | undefined)?.trim();
            const message = (args["task"] as string | undefined)?.trim();
            if (!identifier) {
                return "错误：action='send' 需要提供 name 作为目标子 Agent 名称。";
            }
            if (!message) {
                return "错误：action='send' 需要提供 task 作为发送内容。";
            }

            const result = await sendMessageToSubAgent(identifier, message, {
                parentTurnId: `turn_${Date.now()}`,
                sourceAgentId: this.parentAgentName,
                sourceAgentName: this.parentAgentName,
                channel: "a2a",
                ...(onProgress ? { onProgress } : {}),
            });
            return JSON.stringify(
                {
                    request: createA2ARequest({
                        operation: "send",
                        sourceAgentId: this.parentAgentName,
                        sourceAgentName: this.parentAgentName,
                        targetAgentName: identifier,
                        message,
                    }),
                    response: {
                        ok: true,
                        target: identifier,
                        content: result.finalContent,
                    },
                },
                null,
                2,
            );
        }

        if (action === "delete") {
            const identifier =
                (args["name"] as string | undefined) ??
                (args["task"] as string | undefined);
            if (!identifier?.trim()) {
                return "错误：action='delete' 需要提供 name 或 task 参数作为子 Agent 名称/ID。";
            }
            const deleted = await deleteSubAgent(identifier.trim());
            return deleted
                ? `子 Agent ${identifier.trim()} 已删除。`
                : `未找到子 Agent ${identifier.trim()}。`;
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

        if (wait) {
            try {
                const result = await runSubAgentTask(
                    entry,
                    onProgress ? { onProgress } : undefined,
                );

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

                return `子 Agent 执行失败: ${errMsg}`;
            }
        }

        runSubAgentTask(entry, onProgress ? { onProgress } : undefined)
            .then((result) => {
            })
            .catch((err) => {
            });

        return JSON.stringify(
            {
                request: buildSubAgentRequest(entry, "create", {
                    message: task,
                    ...(contextParam !== undefined ? { context: contextParam } : {}),
                }),
                agent: toAgentDescriptor(entry),
                status: "running",
                message: `子 Agent @${subAgentName} 已在后台启动。完成后结果会自动推送到主 Agent 的消息队列。`,
            },
            null,
            2,
        );
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
