// src/tools/sub-agent-tool.ts
//
// SubAgentTool —— 子 Agent 委派工具（A2A 协议 + 事件驱动）。
//
// 核心设计：
//   - 子 Agent 通过父级 MessageQueue 发送 A2A 事件（start / progress / complete / error）
//   - 后台任务完成后**主动推送**结果到父级消息队列，而非让主 Agent 轮询
//   - 结果通过 SubAgentResultReady 事件自动注入到主 Agent 的待处理结果管道
//   - 主 Agent 的 buildContext() 会在下一轮对话时自动注入待处理结果
//
// A2A 协议事件流（所有事件发往父级 MessageQueue）：
//   SUB_AGENT_START    → 子 Agent 启动
//   SUB_AGENT_PROGRESS → 进度更新（LLM 调用步骤）
//   SUB_AGENT_COMPLETE  → 任务完成（同步等待时）
//   SUB_AGENT_ERROR     → 任务失败
//   SUB_AGENT_RESULT_READY → 后台任务结果已推送，等待消费
//
// 与旧版的关键区别：
//   - ❌ 不再使用 action='get_result' 轮询子 Agent 状态
//   - ✅ 子 Agent 完成 → 推送事件 → 结果进入管道 → 自动注入上下文

import type OpenAI from "openai";
import { BaseTool, ToolRegistry, type ToolParam } from "./basetool.js";
import type { Agent } from "../agent/agent.js";
import { runAgentTask, type AgentTaskResult } from "../agent/agent-task.js";
import { MessageQueue } from "../agent/message-queue.js";
import { CORE_SYSTEM_PROMPT, buildAgentIdentity } from "../agent/prompts.js";
import { AgentEventType } from "../agent/events.js";
import type {
    SubAgentStartEvent,
    SubAgentProgressEvent,
    SubAgentCompleteEvent,
    SubAgentErrorEvent,
    SubAgentResultReadyEvent,
} from "../agent/events.js";

// ── 待处理结果管道（模块级单例）────────────────────────────────
//
// 后台子 Agent 完成后，结果通过 SUB_AGENT_RESULT_READY 事件推送到此管道。
// 主 Agent 的 buildContext() 在每次构建上下文时自动排出并注入。
// 这不是轮询 —— 结果是由子 Agent 主动推送的，管道只是暂存。

export interface PendingSubAgentResult {
    subAgentId: string;
    task: string;
    finalContent: string;
    elapsedMs: number;
    completedAt: number;
}

const pendingResults: PendingSubAgentResult[] = [];

/** 子 Agent 完成后调用 —— 将结果推入待处理管道（由事件订阅者触发） */
export function pushPendingResult(result: PendingSubAgentResult): void {
    pendingResults.push(result);
}

/** 排出并清空所有待处理结果（由 Agent.buildContext 或 consume_results 工具调用） */
export function drainPendingResults(): PendingSubAgentResult[] {
    if (pendingResults.length === 0) return [];
    const results = [...pendingResults];
    pendingResults.length = 0;
    return results;
}

/** 查询是否有待处理结果 */
export function hasPendingResults(): boolean {
    return pendingResults.length > 0;
}

// ── 后台任务存储（仅用于同步等待取消等高级场景）──────────────

interface SubAgentEntry {
    promise: Promise<AgentTaskResult>;
    status: "running" | "completed" | "failed";
    startedAt: number;
    task: string;
    result?: AgentTaskResult;
    error?: string;
}

const subAgentStore = new Map<string, SubAgentEntry>();

function generateSubAgentId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── 子 Agent 工具 ───────────────────────────────────────────────

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
            description:
                "子 Agent 的任务描述。action='delegate' 时必填。",
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
            description:
                "子 Agent 使用的模型名。不填则使用当前模型。",
            required: false,
        },
        {
            name: "allowed_tools",
            type: "string",
            description:
                "逗号分隔的允许工具名列表。不填则子 Agent 可用全部工具。",
            required: false,
        },
        {
            name: "context",
            type: "string",
            description:
                "附加给子 Agent 的上下文或指令（注入到系统提示词）。",
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

    /** 父级 ToolRegistry（通过 onInit 注入） */
    private parentRegistry: ToolRegistry | null = null;
    /** 父级 MessageQueue（通过 onInit 注入）—— A2A 事件发往此总线 */
    private parentBus: MessageQueue | null = null;
    /** 父级 Agent 名称（用于 A2A 事件关联） */
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
        const action =
            (args["action"] as string | undefined) ?? "delegate";

        // ── drain_results 操作 ──────────────────────────────
        if (action === "drain_results") {
            const results = drainPendingResults();
            if (results.length === 0) {
                return "没有待处理的后台子 Agent 结果。";
            }

            const parts: string[] = [
                `已排出 ${results.length} 个后台子 Agent 结果：`,
                "",
            ];
            for (const r of results) {
                parts.push(
                    `── 子 Agent ${r.subAgentId} ──`,
                    `任务: ${r.task.slice(0, 200)}`,
                    `耗时: ${(r.elapsedMs / 1000).toFixed(1)}s`,
                    `结果: ${r.finalContent.slice(0, 500)}`,
                    "",
                );
            }
            return parts.join("\n");
        }

        // ── delegate 操作 ────────────────────────────────────
        const task = args["task"] as string | undefined;
        if (!task || !task.trim()) {
            return "错误：action='delegate' 需要提供非空的 task 参数。";
        }

        const wait =
            (args["wait"] as boolean | undefined) ?? true;
        const model = args["model"] as string | undefined;
        const contextParam = args["context"] as string | undefined;

        // 解析工具白名单
        const allowedToolsRaw = args["allowed_tools"] as
            | string
            | undefined;
        const allowedToolsList = allowedToolsRaw
            ? allowedToolsRaw
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
            : undefined;

        // 参数校验
        if (!this.parentRegistry) {
            return "错误：子 Agent 工具尚未初始化（parentRegistry 为空）。";
        }
        if (!this.parentBus) {
            return "错误：子 Agent 工具尚未初始化（parentBus 为空）。";
        }

        // 创建过滤后的工具注册表
        const filteredRegistry =
            this.parentRegistry.createFiltered(allowedToolsList);

        // 构建子 Agent 上下文消息
        const context = this.buildSubAgentContext(
            task,
            contextParam,
        );

        // 子 Agent 唯一 ID
        const subAgentId = generateSubAgentId();
        const parentTurnId = `turn_${Date.now()}`;

        // 为子 Agent 创建小型内部 MessageQueue（内部 LLM 事件隔离）
        // 关键：内部 bus 仅用于 runAgentTask 的内部事件循环。
        // A2A 生命周期事件通过桥接发送到 parentBus。
        const internalBus = new MessageQueue({ maxSize: 200 });

        // ── 事件桥接：内部事件 → A2A 事件 → 父级消息队列 ──
        this.bridgeEvents(
            internalBus,
            this.parentBus,
            subAgentId,
            parentTurnId,
            task,
            model ?? "default",
            allowedToolsList ?? [],
            onProgress,
        );

        // 自动批准所有工具
        const autoConfirm = async () =>
            ({ approved: true }) as const;

        // 发出 A2A 启动事件
        const startEvent: SubAgentStartEvent = {
            type: AgentEventType.SUB_AGENT_START,
            subAgentId,
            parentTurnId,
            task: task.slice(0, 200),
            model: model ?? "default",
            allowedTools: allowedToolsList ?? [],
        };
        this.parentBus.enqueue(startEvent);

        // 创建子 Agent 任务 Promise
        const taskPromise = runAgentTask({
            registry: filteredRegistry,
            bus: internalBus,
            context,
            turnId: subAgentId,
            confirmFn: autoConfirm,
            ...(model !== undefined ? { model } : {}),
        });

        if (wait) {
            // ── 同步等待 ──────────────────────────────────
            try {
                const result = await taskPromise;

                // 发出 A2A 完成事件
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
                    "子 Agent 任务完成 ✅",
                    "",
                    `耗时: ${(result.elapsedMs / 1000).toFixed(1)}s`,
                    `LLM 调用次数: ${result.totalLlmCalls}`,
                    `工具调用次数: ${result.totalToolCalls}`,
                    "",
                    "── 结果 ──",
                    result.finalContent,
                ].join("\n");
            } catch (error) {
                const errMsg =
                    error instanceof Error
                        ? error.message
                        : String(error);

                // 发出 A2A 错误事件
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
        } else {
            // ── 后台运行（事件驱动推送）────────────────────
            const entry: SubAgentEntry = {
                promise: taskPromise,
                status: "running",
                startedAt: Date.now(),
                task,
            };
            subAgentStore.set(subAgentId, entry);

            // 后台完成处理：推送结果到父级消息队列 + 待处理管道
            taskPromise
                .then((result) => {
                    entry.status = "completed";
                    entry.result = result;

                    // 1) 发出 SUB_AGENT_COMPLETE A2A 事件
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

                    // 2) 发出 SUB_AGENT_RESULT_READY —— 触发结果管道注入
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
                    entry.error =
                        err instanceof Error
                            ? err.message
                            : String(err);

                    // 发出 A2A 错误事件
                    const errorEvent: SubAgentErrorEvent = {
                        type: AgentEventType.SUB_AGENT_ERROR,
                        subAgentId,
                        parentTurnId,
                        task: task.slice(0, 200),
                        error: entry.error!,
                    };
                    this.parentBus?.enqueue(errorEvent);
                });

            return JSON.stringify(
                {
                    sub_agent_id: subAgentId,
                    status: "running",
                    message:
                        "子 Agent 已在后台启动。完成后结果会自动推送到主 Agent 的消息队列。" +
                        "主 Agent 下一轮对话时会自动看到结果（被动注入上下文）。" +
                        `也可使用 action='drain_results' 主动消费已推送的结果。`,
                },
                null,
                2,
            );
        }
    }

    // ── 私有方法 ──────────────────────────────────────────────

    /**
     * 桥接子 Agent 内部事件到父级 MessageQueue。
     *
     * 监听内部 bus 的关键事件，转换为 A2A 协议事件后发往 parentBus。
     * 这确保了：
     *   - 子 Agent 的 LLM token 不会污染父级 TUI（内部 bus 是隔离的）
     *   - A2A 生命周期事件正确路由到父级消息队列
     *   - 父级可以订阅这些事件来追踪子 Agent 进度
     */
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
        // TASK_STEP → SUB_AGENT_PROGRESS
        internalBus.subscribe(
            AgentEventType.TASK_STEP,
            (event) => {
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
            },
        );

        // TASK_ERROR → SUB_AGENT_ERROR（运行时错误也在 execute 中处理，
        // 这里捕获 runAgentTask 内部的中间件级错误）
        internalBus.subscribe(
            AgentEventType.TASK_ERROR,
            (event) => {
                if (event.type === AgentEventType.TASK_ERROR) {
                    const errorEvent: SubAgentErrorEvent = {
                        type: AgentEventType.SUB_AGENT_ERROR,
                        subAgentId,
                        parentTurnId,
                        task: task.slice(0, 200),
                        error: event.error,
                    };
                    parentBus.enqueue(errorEvent);
                    onProgress?.(`[子Agent ${subAgentId}] ❌ ${event.error}`);
                }
            },
        );
    }

    /**
     * 为子 Agent 构建初始 LLM 上下文消息数组。
     *
     * 消息顺序（缓存优化）：
     *   1. 子 Agent 身份
     *   2. 核心系统提示词（工具描述与规则）
     *   3. 用户提供的附加上下文（如有）
     *   4. 任务描述（user 消息）
     *
     * 注意：不注入 USER.md / MEMORY.md —— 子 Agent 是无状态的 worker。
     */
    private buildSubAgentContext(
        task: string,
        extraContext?: string,
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

        // Layer 1: 子 Agent 身份
        messages.push({
            role: "system",
            content: buildAgentIdentity(
                `SubAgent — 一个专门执行委派任务的独立子 Agent。` +
                    `仅使用提供的工具完成任务，完成后返回结果。` +
                    `你是 "${this.parentAgentName}" 的子 Agent，通过 A2A 协议通信。`,
            ),
        });

        // Layer 2: 核心系统提示词（工具描述与规则）
        messages.push({
            role: "system",
            content: CORE_SYSTEM_PROMPT,
        });

        // Layer 3: 用户提供的附加上下文
        if (extraContext && extraContext.trim()) {
            messages.push({
                role: "system",
                content: `[子 Agent 额外指令]\n${extraContext}`,
            });
        }

        // Layer 4: 任务描述
        messages.push({
            role: "user",
            content: task,
        });

        return messages;
    }
}
