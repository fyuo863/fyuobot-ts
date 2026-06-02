// src/agent/agent.ts
import type OpenAI from "openai";
import { ToolRegistry } from "../tools/basetool.js";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 创建一个 Agent 所需的配置 */
export interface AgentConfig {
    /** Agent 唯一名称 */
    name: string;
    /** Agent 的系统提示词（决定其行为和人格） */
    systemPrompt: string;
}

/** Agent 的即时状态快照 */
export interface AgentStatus {
    name: string;
    busy: boolean;
    lastActivity: string;
    toolCount: number;
}

// ── Agent 实现 ────────────────────────────────────────────────

/**
 * 单 Agent —— 接收用户查询，运行 LLM 工具调用循环，返回最终响应。
 *
 * 每个 Agent 持有一个 ToolRegistry，工具由外部统一注入。
 */
export class Agent {
    readonly name: string;
    private systemPrompt: string;
    readonly registry: ToolRegistry;
    private _busy = false;
    private _lastActivity = "";

    constructor(config: AgentConfig, registry: ToolRegistry) {
        this.name = config.name;
        this.systemPrompt = config.systemPrompt;
        this.registry = registry;
        this._lastActivity = "已就绪";
    }

    // ── 状态 ──────────────────────────────────────────────

    /** 即时状态快照 */
    get status(): AgentStatus {
        return {
            name: this.name,
            busy: this._busy,
            lastActivity: this._lastActivity,
            toolCount: this.registry.size,
        };
    }

    // ── 任务执行（对外接口）─────────────────────────────────

    /**
     * 执行用户查询：构建 LLM 上下文（系统提示词 + 用户消息），
     * 运行 LLM 工具调用循环，最后返回 LLM 的最终文本响应。
     *
     * @returns LLM 最终响应文本
     * @throws 如果 LLM 调用或工具执行过程中出错
     */
    async runTask(query: string): Promise<string> {
        this._busy = true;
        this._lastActivity = "执行查询";

        const context: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: "system", content: this.systemPrompt },
            { role: "user", content: query },
        ];

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

            this._lastActivity = "✅ 完成";
            return finalContent || "任务完成（无文本输出）";
        } catch (e) {
            this._lastActivity = "❌ 失败";
            throw e;
        } finally {
            this._busy = false;
        }
    }
}
