import type OpenAI from "openai";
import { BaseTool, ToolRegistry, type ToolParam } from "./basetool.js";
import type { Agent } from "../agent/agent.js";
import { runAgentTask, type AgentTaskResult } from "../agent/agent-task.js";
import { MessageQueue } from "../agent/message-queue.js";
import {
    buildAgentIdentity,
    buildOrderedPromptMessages,
} from "../agent/prompts.js";
import { AgentEventType } from "../agent/events.js";
import type {
    SubAgentStartEvent,
    SubAgentProgressEvent,
    SubAgentCompleteEvent,
    SubAgentErrorEvent,
    SubAgentResultReadyEvent,
} from "../agent/events.js";

export interface PendingSubAgentResult {
    subAgentId: string;
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
    promise: Promise<AgentTaskResult>;
    status: "running" | "completed" | "failed";
    startedAt: number;
    task: string;
    result?: AgentTaskResult;
    error?: string;
}

const subAgentStore = new Map<string, SubAgentEntry>();

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
        const context = this.buildSubAgentContext(task, contextParam);
        const subAgentId = generateSubAgentId();
        const parentTurnId = `turn_${Date.now()}`;
        const internalBus = new MessageQueue({ maxSize: 200 });

        this.bridgeEvents(
            internalBus,
            this.parentBus,
            subAgentId,
            parentTurnId,
            task,
            model ?? "default",
            allowedToolsList,
            onProgress,
        );

        const autoConfirm = async () => ({ approved: true }) as const;

        const startEvent: SubAgentStartEvent = {
            type: AgentEventType.SUB_AGENT_START,
            subAgentId,
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
            ...(model !== undefined ? { model } : {}),
        });

        if (wait) {
            try {
                const result = await taskPromise;

                const completeEvent: SubAgentCompleteEvent = {
                    type: AgentEventType.SUB_AGENT_COMPLETE,
                    subAgentId,
                    parentTurnId,
                    task: task.slice(0, 200),
                    finalContent: result.finalContent,
                    totalToolCalls: result.totalToolCalls,
                    totalLlmCalls: result.totalLlmCalls,
                    elapsedMs: result.elapsedMs,
                };
                this.parentBus.enqueue(completeEvent);

                return [
                    "子 Agent 任务完成",
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

                const errorEvent: SubAgentErrorEvent = {
                    type: AgentEventType.SUB_AGENT_ERROR,
                    subAgentId,
                    parentTurnId,
                    task: task.slice(0, 200),
                    error: errMsg,
                };
                this.parentBus.enqueue(errorEvent);

                return `子 Agent 执行失败: ${errMsg}`;
            }
        }

        const entry: SubAgentEntry = {
            promise: taskPromise,
            status: "running",
            startedAt: Date.now(),
            task,
        };
        subAgentStore.set(subAgentId, entry);

        taskPromise
            .then((result) => {
                entry.status = "completed";
                entry.result = result;

                const completeEvent: SubAgentCompleteEvent = {
                    type: AgentEventType.SUB_AGENT_COMPLETE,
                    subAgentId,
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
                    parentTurnId,
                    task: task.slice(0, 200),
                    finalContent: result.finalContent,
                    elapsedMs: result.elapsedMs,
                };
                this.parentBus?.enqueue(readyEvent);
            })
            .catch((err) => {
                entry.status = "failed";
                entry.error = err instanceof Error ? err.message : String(err);

                const errorEvent: SubAgentErrorEvent = {
                    type: AgentEventType.SUB_AGENT_ERROR,
                    subAgentId,
                    parentTurnId,
                    task: task.slice(0, 200),
                    error: entry.error,
                };
                this.parentBus?.enqueue(errorEvent);
            });

        return JSON.stringify(
            {
                sub_agent_id: subAgentId,
                status: "running",
                allowed_tools: allowedToolsList,
                message:
                    "子 Agent 已在后台启动。完成后结果会自动推送到主 Agent 的消息队列。",
            },
            null,
            2,
        );
    }

    private bridgeEvents(
        internalBus: MessageQueue,
        parentBus: MessageQueue,
        subAgentId: string,
        parentTurnId: string,
        task: string,
        _model: string,
        _allowedTools: string[],
        onProgress?: (chunk: string) => void,
    ): void {
        internalBus.subscribe(AgentEventType.TASK_STEP, (event) => {
            if (event.type === AgentEventType.TASK_STEP) {
                const progressEvent: SubAgentProgressEvent = {
                    type: AgentEventType.SUB_AGENT_PROGRESS,
                    subAgentId,
                    parentTurnId,
                    task: task.slice(0, 200),
                    message: event.action,
                };
                parentBus.enqueue(progressEvent);
                onProgress?.(`[子Agent ${subAgentId}] ${event.action}`);
            }
        });

        internalBus.subscribe(AgentEventType.TASK_ERROR, (event) => {
            if (event.type === AgentEventType.TASK_ERROR) {
                const errorEvent: SubAgentErrorEvent = {
                    type: AgentEventType.SUB_AGENT_ERROR,
                    subAgentId,
                    parentTurnId,
                    task: task.slice(0, 200),
                    error: event.error,
                };
                parentBus.enqueue(errorEvent);
                onProgress?.(`[子Agent ${subAgentId}] 失败: ${event.error}`);
            }
        });
    }

    private buildSubAgentContext(
        task: string,
        extraContext?: string,
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const identity = buildAgentIdentity(
            `SubAgent - 一个专门执行委派任务的独立子 Agent。仅使用提供的工具完成任务，完成后返回结果。你是 "${this.parentAgentName}" 的子 Agent，通过 A2A 协议通信。`,
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
