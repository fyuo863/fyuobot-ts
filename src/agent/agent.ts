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
    /**
     * Layer 1 — 核心系统提示词（不经常变动的内容：工具描述、工作规则等）。
     * 放在消息数组最前面，作为 LLM prompt cache 的缓存前缀。
     */
    systemPrompt: string;
    /**
     * Layer 2 — Agent 身份设定（相对易变的内容：角色、人格等）。
     * 放在核心系统提示词之后，切换 agent 时才变化。
     * 可选：不提供则只有一层系统提示词。
     */
    identity?: string;
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
    /** Layer 1 — 核心系统提示词（缓存前缀） */
    private systemPrompt: string;
    /** Layer 2 — Agent 身份设定（可选） */
    private identity: string | undefined;
    readonly registry: ToolRegistry;
    private _busy = false;
    private _lastActivity = "";

    constructor(config: AgentConfig, registry: ToolRegistry) {
        this.name = config.name;
        this.systemPrompt = config.systemPrompt;
        this.identity = config.identity;
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
     * 构建用于 LLM 调用的初始消息上下文。
     *
     * 消息按缓存优化顺序排列：
     *   1. 核心系统提示词（Layer 1, 最稳定 → 缓存前缀）
     *   2. Agent 身份（Layer 2, 按 agent 变化）
     *   3. 用户查询（每次变化）
     */
    private buildContext(query: string): OpenAI.Chat.ChatCompletionMessageParam[] {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: "system", content: this.systemPrompt },
        ];
        if (this.identity) {
            messages.push({ role: "system", content: this.identity });
        }
        messages.push({ role: "user", content: query });
        return messages;
    }

    async runTask(query: string): Promise<string> {
        this._busy = true;
        this._lastActivity = "执行查询";

        const context = this.buildContext(query);

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

            // ── 被动触发：自动检测 + 处理超阈值文件 ──
            import("../tools/compress-tool.js").then(({ CompressTool }) => {
                CompressTool.autoCompress().then((logs) => {
                    for (const log of logs) {
                        console.log(`  ${log}`);
                    }
                });
            });
        }
    }
}
