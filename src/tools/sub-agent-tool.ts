// src/tools/sub-agent-tool.ts
//
// SubAgentTool —— 子 Agent 委派工具。
//
// 主 Agent 可通过此工具 spawn 独立的子 Agent 来并行/独立处理子任务。
// 支持同步等待（wait=true，默认）和后台异步（wait=false）两种模式。
//
// 关键设计：
//   - 子 Agent 使用独立的 MessageQueue，事件不会污染父级 TUI
//   - 通过 onProgress 回调将关键里程碑通知父级
//   - 后台任务存储在模块级 Map 中，通过 action='get_result' 查询

import type OpenAI from "openai";
import { BaseTool, ToolRegistry, type ToolParam } from "./basetool.js";
import type { Agent } from "../agent/agent.js";
import { runAgentTask, type AgentTaskResult } from "../agent/agent-task.js";
import { MessageQueue } from "../agent/message-queue.js";
import { CORE_SYSTEM_PROMPT, buildAgentIdentity } from "../agent/prompts.js";
import { AgentEventType } from "../agent/events.js";

// ── 后台任务存储（模块级单例）──────────────────────────────────

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

/** 提交后台任务并返回 sub_agent_id */
function submitSubAgent(
    task: string,
    promise: Promise<AgentTaskResult>,
): string {
    const id = generateSubAgentId();
    const entry: SubAgentEntry = {
        promise,
        status: "running",
        startedAt: Date.now(),
        task,
    };
    subAgentStore.set(id, entry);

    promise
        .then((result) => {
            entry.status = "completed";
            entry.result = result;
        })
        .catch((err) => {
            entry.status = "failed";
            entry.error =
                err instanceof Error ? err.message : String(err);
        });

    return id;
}

/** 查询后台任务状态 */
function getSubAgentEntry(id: string): SubAgentEntry | undefined {
    return subAgentStore.get(id);
}

// ── 子 Agent 工具 ───────────────────────────────────────────────

export class SubAgentTool extends BaseTool {
    name = "delegate_task";

    description = [
        "将任务委派给一个独立的子 Agent 执行。",
        "",
        "使用场景：",
        "- 将复杂任务拆解为多个独立子任务并行处理",
        "- 用不同的模型或受限的工具集执行特定子任务",
        "- 在后台执行长时间运行的任务，稍后查询结果",
        "",
        "操作模式：",
        "- action='delegate'（默认）：spawn 子 Agent 执行任务",
        "  - wait=true（默认）：等待完成，返回最终结果",
        "  - wait=false：立即返回 sub_agent_id，稍后用 action='get_result' 查询",
        "- action='get_result'：查询后台子 Agent 的结果",
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
                "操作类型：'delegate'（spawn 子 Agent，默认）或 'get_result'（查询后台任务结果）",
            required: false,
            enum: ["delegate", "get_result"],
        },
        {
            name: "sub_agent_id",
            type: "string",
            description:
                "后台子 Agent 的 ID（来自之前 wait=false 调用返回的 sub_agent_id）。action='get_result' 时必填。",
            required: false,
        },
        {
            name: "model",
            type: "string",
            description:
                "子 Agent 使用的模型名（如 'deepseek-chat'、'gpt-4o'）。不填则使用当前模型。",
            required: false,
        },
        {
            name: "allowed_tools",
            type: "string",
            description:
                "逗号分隔的允许工具名列表（如 'calculator,file_operator'）。不填则子 Agent 可用全部工具。",
            required: false,
        },
        {
            name: "context",
            type: "string",
            description:
                "附加给子 Agent 的上下文或指令（会注入到系统提示词中）。",
            required: false,
        },
        {
            name: "wait",
            type: "boolean",
            description:
                "是否等待子 Agent 完成。true=等待完成后返回结果（默认），false=后台运行，立即返回 sub_agent_id。",
            required: false,
        },
    ];

    /** 父级 ToolRegistry 引用（通过 onInit 注入） */
    private parentRegistry: ToolRegistry | null = null;

    onInit(agent: Agent): void {
        this.parentRegistry = agent.registry;
    }

    async execute(
        args: Record<string, unknown>,
        onProgress?: (chunk: string) => void,
    ): Promise<string> {
        const action =
            (args["action"] as string | undefined) ?? "delegate";
        const subAgentId = args["sub_agent_id"] as string | undefined;

        // ── get_result 操作 ──────────────────────────────────
        if (action === "get_result" || (subAgentId && !args["task"])) {
            if (!subAgentId) {
                return "错误：action='get_result' 需要提供 sub_agent_id 参数。";
            }

            const entry = getSubAgentEntry(subAgentId);
            if (!entry) {
                return `错误：未找到子 Agent "${subAgentId}"。可能已过期或 ID 无效。`;
            }

            switch (entry.status) {
                case "running":
                    return [
                        `子 Agent "${subAgentId}" 仍在运行中。`,
                        `任务: ${entry.task.slice(0, 200)}`,
                        `已运行: ${Math.round((Date.now() - entry.startedAt) / 1000)}s`,
                        "",
                        "请稍后再查询。",
                    ].join("\n");
                case "completed":
                    return [
                        "子 Agent 任务完成 ✅",
                        "",
                        `子 Agent ID: ${subAgentId}`,
                        `耗时: ${(entry.result!.elapsedMs / 1000).toFixed(1)}s`,
                        `LLM 调用次数: ${entry.result!.totalLlmCalls}`,
                        `工具调用次数: ${entry.result!.totalToolCalls}`,
                        "",
                        "── 结果 ──",
                        entry.result!.finalContent,
                    ].join("\n");
                case "failed":
                    return [
                        "子 Agent 任务失败 ❌",
                        "",
                        `子 Agent ID: ${subAgentId}`,
                        `错误: ${entry.error}`,
                    ].join("\n");
            }
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

        // 创建过滤后的工具注册表
        if (!this.parentRegistry) {
            return "错误：子 Agent 工具尚未初始化（parentRegistry 为空）。请确保 Agent 已完全启动。";
        }
        const filteredRegistry =
            this.parentRegistry.createFiltered(allowedToolsList);

        // 构建子 Agent 上下文消息
        const context = this.buildSubAgentContext(
            task,
            contextParam,
        );

        // 创建独立的 MessageQueue（事件隔离）
        const subBus = new MessageQueue({ maxSize: 500 });

        // 订阅关键事件以通过 onProgress 反馈给父级
        if (onProgress) {
            subBus.subscribe(
                AgentEventType.TASK_STEP,
                (event) => {
                    if (event.type === AgentEventType.TASK_STEP) {
                        onProgress(`[子Agent] ${event.action}`);
                    }
                },
            );
            subBus.subscribe(
                AgentEventType.TASK_COMPLETE,
                (event) => {
                    if (event.type === AgentEventType.TASK_COMPLETE) {
                        onProgress(
                            `[子Agent] ✅ 完成 (${event.totalToolCalls} 次工具调用, ${(event.elapsedMs / 1000).toFixed(1)}s)`,
                        );
                    }
                },
            );
            subBus.subscribe(
                AgentEventType.TASK_ERROR,
                (event) => {
                    if (event.type === AgentEventType.TASK_ERROR) {
                        onProgress(
                            `[子Agent] ❌ 失败: ${event.error}`,
                        );
                    }
                },
            );
        }

        // 自动批准所有工具（子 Agent 继承父级信任，无 TUI 交互能力）
        const autoConfirm = async () =>
            ({ approved: true }) as const;

        // 创建并执行子 Agent 任务
        const taskPromise = runAgentTask({
            registry: filteredRegistry,
            bus: subBus,
            context,
            turnId: generateSubAgentId(),
            confirmFn: autoConfirm,
            ...(model !== undefined ? { model } : {}),
        });

        if (wait) {
            // ── 同步等待 ──────────────────────────────────
            try {
                const result = await taskPromise;
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
                return `子 Agent 执行失败: ${error instanceof Error ? error.message : String(error)}`;
            }
        } else {
            // ── 后台运行 ──────────────────────────────────
            const id = submitSubAgent(task, taskPromise);
            return JSON.stringify(
                {
                    sub_agent_id: id,
                    status: "running",
                    message: `子 Agent 已在后台启动。使用 action='get_result' 和 sub_agent_id='${id}' 查询结果。`,
                },
                null,
                2,
            );
        }
    }

    // ── 私有方法 ──────────────────────────────────────────────

    /**
     * 为子 Agent 构建初始 LLM 上下文消息数组。
     *
     * 消息顺序（缓存优化）：
     *   1. 子 Agent 身份
     *   2. 工具使用规则
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
                "SubAgent — 一个专门执行委派任务的独立子 Agent。仅使用提供的工具完成任务，完成后返回结果。",
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
