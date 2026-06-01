// src/agent/agent.ts
import type OpenAI from "openai";
import { Router } from "../router/router.js";
import type { Task } from "../router/router.js";
import { BaseTool, ToolRegistry } from "../tools/basetool.js";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 创建一个 Agent 所需的配置 */
export interface AgentConfig {
    /** Agent 唯一名称，同时作为 Router 中的注册名 */
    name: string;
    /** 该 Agent 专属的系统提示词（决定其行为和人格） */
    systemPrompt: string;
    /** 该 Agent 可使用的工具列表（各 Agent 工具集独立） */
    tools: BaseTool[];
}

/** Agent 的即时状态快照 */
export interface AgentStatus {
    name: string;
    pendingTasks: number;
    busy: boolean;
    lastActivity: string;
    toolCount: number;
}

// ── Agent 实现 ────────────────────────────────────────────────

/**
 * 被动任务执行器 —— 不主动轮询，由上层（agentLogic）调度执行。
 *
 * 与 Router 的关系：
 * - 构造时自动调用 router.register(name)
 * - 由调用方传入 Task，runTask() 内部运行 LLM 循环并返回结果
 * - **不再负责完成/失败标记** —— 调用方根据返回值决定 router.complete() / router.fail()
 *
 * 每个 Agent 实例之间零耦合，仅通过共享 Router 交换数据。
 */
export class Agent {
    readonly name: string;
    private systemPrompt: string;
    private registry: ToolRegistry;
    private router: Router;
    private _busy = false;
    private _lastActivity = "";

    constructor(config: AgentConfig, router: Router) {
        this.name = config.name;
        this.systemPrompt = config.systemPrompt;
        this.router = router;

        // 构建该 Agent 专属的工具注册中心
        this.registry = new ToolRegistry();
        for (const tool of config.tools) {
            this.registry.register(tool);
        }

        // 向共享 Router 报到
        this.router.register(config.name);
        this._lastActivity = "已注册";
    }

    // ── 状态 ──────────────────────────────────────────────

    /** 即时状态快照 */
    get status(): AgentStatus {
        return {
            name: this.name,
            pendingTasks: this.router.pendingCount(this.name),
            busy: this._busy,
            lastActivity: this._lastActivity,
            toolCount: this.registry.size,
        };
    }

    // ── 任务执行（对外接口）─────────────────────────────────

    /**
     * 执行一个任务：构建独立的 LLM 上下文（系统提示词 + 任务内容），
     * 运行 LLM 工具调用循环，最后返回 LLM 的最终文本响应。
     *
     * **不调用 router.complete / router.fail** —— 由上层调度者决定。
     *
     * @returns LLM 最终响应文本
     * @throws 如果 LLM 调用或工具执行过程中出错
     */
    async runTask(task: Task): Promise<string> {
        this._busy = true;
        this._lastActivity = `执行: ${task.id}`;

        // 每次任务独立的 LLM 上下文
        const context: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: "system", content: this.systemPrompt },
        ];

        const taskPrompt = [
            `--- 📋 新任务 ---`,
            `ID:     ${task.id}`,
            `来源:   ${task.from}`,
            `类型:   ${task.type}`,
            `负载:   ${JSON.stringify(task.payload, null, 2)}`,
            `-------------------`,
            `请执行上述任务。使用你拥有的工具来完成任务，完成后简要说明结果。`,
        ].join("\n");

        context.push({ role: "user", content: taskPrompt });

        try {
            let result: SendResult;
            let finalContent = "";

            do {
                result = await sendMessage(context, {
                    tools: this.registry.toOpenAITools(),
                });

                context.push({
                    role: "assistant",
                    content: result.content || null,
                    ...(result.toolCalls?.length
                        ? { tool_calls: result.toolCalls }
                        : {}),
                });

                finalContent = result.content || "";

                // 执行工具调用
                if (result.toolCalls?.length) {
                    for (const tc of result.toolCalls) {
                        this._lastActivity = `工具: ${tc.function.name}`;
                        const args = JSON.parse(
                            tc.function.arguments,
                        ) as Record<string, unknown>;
                        const toolResult = await this.registry.execute(
                            tc.function.name,
                            args,
                        );
                        context.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: toolResult,
                        });
                    }
                }
            } while (result.toolCalls?.length);

            this._lastActivity = `✅ 完成: ${task.id}`;
            return finalContent || "任务完成（无文本输出）";
        } catch (e) {
            this._lastActivity = `❌ 失败: ${task.id}`;
            throw e;
        } finally {
            this._busy = false;
        }
    }
}
