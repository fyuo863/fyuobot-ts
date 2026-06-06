// src/agent/stream.ts
//
// 框架无关的 Agent 流式会话层。
// 从 agentLogic.ts 的 runLLMTurn() 提取，将与 React/UI 相关的状态操作
// 替换为 StreamHandler 回调接口，使 Agent 的流式交互可被任意消费者使用
//（TUI、HTTP SSE、WebSocket 等）。
//
// 与 agentLogic.ts 的关系：
//   - agentLogic.ts 继续为 TUI 服务（保持不变）
//   - 本模块提供独立的 StreamingSession，两者共享底层的 sendMessage()

import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import { estimateTokens, type TokenStats } from "../llm/tokens.js";
import type { Agent } from "./agent.js";
import { buildInitialMessages, buildAgentIdentity } from "./prompts.js";
import { HistoryManager, type ToolCallRecord } from "../memory/history-manager.js";
import { detectProvider, normalizeUsage } from "../middleware/index.js";
import type { NormalizedUsage } from "../middleware/types.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 用户对敏感操作的确认结果 */
export interface ConfirmResult {
    approved: boolean;
    feedback?: string;
}

/**
 * 流式事件回调接口 —— 与 UI/传输无关。
 * StreamingSession 通过此接口将所有可观测事件通知给消费者。
 */
export interface StreamHandler {
    /** 单个文本 token */
    onToken(token: string): void;
    /** <think> 块内容（DeepSeek 等模型的思考过程） */
    onThinking(text: string): void;
    /** 非 think 的流式回答文本 */
    onAnswer(text: string): void;
    /** LLM 请求调用工具 */
    onToolCall(name: string, args: string): void;
    /** 工具执行进度 */
    onToolProgress(name: string, progress: string): void;
    /** 工具执行结果摘要 */
    onToolResult(name: string, summary: string): void;
    /**
     * 敏感操作需要确认。
     * 返回 Promise —— 消费者负责获取用户决定后 resolve。
     */
    onConfirmRequired(
        toolName: string,
        toolArgs: Record<string, unknown>,
    ): Promise<ConfirmResult>;
    /** 查询完成 */
    onDone(
        usage: Record<string, unknown> | undefined,
        finalContent: string,
    ): void;
    /** 处理过程中发生错误 */
    onError(error: Error): void;
    /** Token 统计更新 */
    onTokenStats(stats: TokenStats): void;
}

// ── 初始消息（与 agentLogic.ts 共享同一构建逻辑） ──────────

const DEFAULT_IDENTITY = buildAgentIdentity("fyuobot");

const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] =
    buildInitialMessages(DEFAULT_IDENTITY);

// ── StreamingSession ─────────────────────────────────────────

/**
 * 独立的流式会话 —— 维护自己的消息历史、Token 统计，
 * 通过 StreamHandler 将流式事件通知给消费者。
 *
 * 每个会话拥有独立的消息上下文，互不干扰。
 */
export class StreamingSession {
    private agent: Agent;
    private handler: StreamHandler;
    private messages: OpenAI.Chat.ChatCompletionMessageParam[];
    private _busy = false;

    // Token 统计（与 agentLogic.ts 的 refs 对应）
    private turnInputTokens = 0;
    private turnOutputTokens = 0;
    private sessionInputTokens = 0;
    private sessionOutputTokens = 0;
    private turnStartTime = 0;
    private turnCacheHitTokens = 0;
    private turnCacheMissTokens = 0;

    // 本轮追踪（用于自动记录 HISTORY.md）
    private turnQuery = "";
    private turnResponse = "";
    private turnToolCalls: ToolCallRecord[] = [];

    // 流文本缓冲
    private streamText = "";
    private lastFlushTime = 0;
    private static readonly STREAM_FLUSH_MS = 50;

    constructor(agent: Agent, handler: StreamHandler) {
        this.agent = agent;
        this.handler = handler;
        this.messages = [...INITIAL_MESSAGES];
    }

    // ── 状态 ──────────────────────────────────────────────

    get isBusy(): boolean {
        return this._busy;
    }

    getStatus() {
        return this.agent.status;
    }

    // ── 查询入口 ──────────────────────────────────────────

    /** 提交查询，运行完整 LLM 工具调用循环。阻塞直到完成或出错。 */
    async submitQuery(query: string): Promise<void> {
        if (!query.trim()) return;
        if (this._busy) {
            this.handler.onError(new Error("Agent 正忙，请等待当前任务完成"));
            return;
        }

        this._busy = true;

        // 重置本轮状态
        this.turnQuery = query.trim();
        this.turnResponse = "";
        this.turnToolCalls = [];
        this.turnInputTokens = estimateTokens(query);
        this.turnOutputTokens = 0;
        this.turnCacheHitTokens = 0;
        this.turnCacheMissTokens = 0;
        this.sessionInputTokens += this.turnInputTokens;
        this.turnStartTime = Date.now();
        this.flushTokenStats();

        // 追加用户消息到上下文
        this.messages.push({ role: "user", content: query });
        this.streamText = "";
        this.lastFlushTime = 0;

        try {
            await this.runLLMTurn();
        } catch (error) {
            const err =
                error instanceof Error ? error : new Error(String(error));
            this.handler.onError(err);
        } finally {
            this.flushTokenStats();
            this._busy = false;

            // 被动全量记录对话到 HISTORY.md
            if (this.turnQuery && this.turnResponse) {
                try {
                    HistoryManager.instance().saveTurn(
                        "",
                        this.turnQuery,
                        this.turnResponse,
                        this.turnToolCalls.length > 0
                            ? this.turnToolCalls
                            : undefined,
                    );
                } catch (e) {
                    console.warn(
                        "[history] 记录失败:",
                        e instanceof Error ? e.message : String(e),
                    );
                }
            }

            // 被动触发：检测 + 处理超阈值 HISTORY.md
            HistoryManager.instance().checkAndCondense();
        }
    }

    /** 重置对话上下文 */
    reset(): void {
        this.messages = [...INITIAL_MESSAGES];
        this.turnInputTokens = 0;
        this.turnOutputTokens = 0;
        this.sessionInputTokens = 0;
        this.sessionOutputTokens = 0;
        this.turnStartTime = 0;
        this.turnCacheHitTokens = 0;
        this.turnCacheMissTokens = 0;
        this.flushTokenStats();
        HistoryManager.init();
    }

    // ── 内部：LLM 工具调用循环 ────────────────────────────

    /**
     * 运行 LLM 工具调用循环 —— 与 agentLogic.ts 的 runLLMTurn()
     * 逻辑完全一致，仅将 React state 操作替换为 handler 回调。
     */
    private async runLLMTurn(): Promise<void> {
        const tools = this.agent.registry.toOpenAITools();
        const contextMessages = this.messages;

        let result: SendResult;
        do {
            // 每轮重置流状态
            this.streamText = "";

            result = await sendMessage(contextMessages, {
                tools,
                onToken: (token) => {
                    this.streamText += token;
                    // 实时 token 估算
                    this.turnOutputTokens += estimateTokens(token);
                    this.sessionOutputTokens += estimateTokens(token);

                    const now = Date.now();
                    if (
                        now - this.lastFlushTime >=
                        StreamingSession.STREAM_FLUSH_MS
                    ) {
                        this.flushStreamContent();
                        this.lastFlushTime = now;
                        this.flushTokenStats();
                    }
                },
            });

            // ── 流结束收尾：解析最终文本 ──
            const fullText = result.content || this.streamText || "";
            let finalThink = "";
            let finalNormal = fullText;

            const thinkStart = fullText.indexOf("<think>");
            if (thinkStart !== -1) {
                const thinkEnd = fullText.indexOf("</think>", thinkStart);
                if (thinkEnd !== -1) {
                    finalThink = fullText.substring(
                        thinkStart + 7,
                        thinkEnd,
                    );
                    finalNormal =
                        fullText.substring(0, thinkStart) +
                        fullText.substring(thinkEnd + 8);
                } else {
                    finalThink = fullText.substring(thinkStart + 7);
                    finalNormal = fullText.substring(0, thinkStart);
                }
            }

            // 通知最终文本
            if (finalThink.trim()) {
                this.handler.onThinking(finalThink.trim());
            }
            if (finalNormal.trim()) {
                this.handler.onAnswer(finalNormal.trim());
                this.turnResponse = finalNormal.trim();
            }

            // ── Token 协调：用 API 返回的真实 usage 替换估算 ──
            if (result.usage) {
                const provider = detectProvider(
                    process.env.THIRD_PARTY_BASE_URL,
                );
                const normalized: NormalizedUsage = normalizeUsage(
                    provider,
                    result.usage,
                );

                const estimatedInput = this.turnInputTokens;
                const estimatedOutput = this.turnOutputTokens;

                if (normalized.promptTokens > 0) {
                    this.turnInputTokens = normalized.promptTokens;
                    this.sessionInputTokens +=
                        normalized.promptTokens - estimatedInput;
                }
                if (normalized.completionTokens > 0) {
                    this.turnOutputTokens = normalized.completionTokens;
                    this.sessionOutputTokens +=
                        normalized.completionTokens - estimatedOutput;
                }

                this.turnCacheHitTokens = normalized.cacheHitTokens;
                this.turnCacheMissTokens = normalized.cacheMissTokens;

                this.flushTokenStats();
            }

            // 追加 assistant 消息
            const assistantMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                role: "assistant",
                content: result.content || null,
                ...(result.toolCalls?.length
                    ? { tool_calls: result.toolCalls }
                    : {}),
            };
            contextMessages.push(assistantMsg);

            // ── 工具调用 ──
            if (result.toolCalls?.length) {
                for (const tc of result.toolCalls) {
                    const toolName = tc.function.name;
                    const toolArgsStr = tc.function.arguments;

                    this.handler.onToolCall(toolName, toolArgsStr);

                    const args = JSON.parse(toolArgsStr) as Record<
                        string,
                        unknown
                    >;

                    // ── 追踪本轮工具调用（用于记录到 HISTORY.md）──
                    const callRecord: ToolCallRecord = {
                        name: toolName,
                        args,
                        result: "",
                    };
                    this.turnToolCalls.push(callRecord);

                    // ── 敏感操作确认 ──
                    const tool = this.agent.registry.get(toolName);
                    if (tool?.dangerous) {
                        this.handler.onToolProgress(
                            toolName,
                            "等待确认...",
                        );
                        const confirm =
                            await this.handler.onConfirmRequired(
                                toolName,
                                args,
                            );
                        if (!confirm.approved) {
                            const feedback = confirm.feedback
                                ? `\n[用户反馈]: ${confirm.feedback}`
                                : "\n[用户反馈]: 用户拒绝了此操作，没有提供额外说明";
                            const cancelMsg =
                                `❌ 用户拒绝了敏感操作: ${toolName}\n` +
                                `[原始参数]: ${toolArgsStr}${feedback}\n` +
                                `[提示]: 请根据用户反馈调整操作方案，如需执行替代命令请在下次调用时修改参数`;
                            this.handler.onToolResult(
                                toolName,
                                cancelMsg.slice(0, 500),
                            );
                            callRecord.result = cancelMsg;
                            contextMessages.push({
                                role: "tool",
                                tool_call_id: tc.id,
                                content: cancelMsg,
                            });
                            continue;
                        }
                    }

                    // 执行工具（带进度回调）
                    const toolResult =
                        await this.agent.registry.execute(
                            toolName,
                            args,
                            (progress: string) => {
                                this.handler.onToolProgress(
                                    toolName,
                                    progress,
                                );
                            },
                        );

                    callRecord.result = toolResult;

                    // 工具结果摘要（截断长输出）
                    const summary =
                        toolResult.length > 500
                            ? toolResult.slice(0, 500) +
                              "\n... (已截断)"
                            : toolResult;
                    this.handler.onToolResult(toolName, summary);

                    contextMessages.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: toolResult,
                    });
                }
            }
        } while (result.toolCalls?.length);

        // 通知完成
        this.handler.onDone(
            result.usage,
            this.turnResponse || result.content || "",
        );
    }

    // ── 内部辅助 ──────────────────────────────────────────

    /** 解析当前流文本中的 <think> 标签并分发 */
    private flushStreamContent(): void {
        const fullText = this.streamText;
        let thinkContent = "";
        let normalContent = fullText;

        const thinkStart = fullText.indexOf("<think>");
        if (thinkStart !== -1) {
            const thinkEnd = fullText.indexOf("</think>", thinkStart);
            if (thinkEnd !== -1) {
                thinkContent = fullText.substring(
                    thinkStart + 7,
                    thinkEnd,
                );
                normalContent =
                    fullText.substring(0, thinkStart) +
                    fullText.substring(thinkEnd + 8);
            } else {
                thinkContent = fullText.substring(thinkStart + 7);
                normalContent = fullText.substring(0, thinkStart);
            }
        }

        if (thinkContent) this.handler.onThinking(thinkContent);
        if (normalContent) this.handler.onAnswer(normalContent);
    }

    /** 计算并发送最新 Token 统计 */
    private flushTokenStats(): void {
        const elapsed = this.turnStartTime
            ? (Date.now() - this.turnStartTime) / 1000
            : 0;
        this.handler.onTokenStats({
            turnInputTokens: this.turnInputTokens,
            turnOutputTokens: this.turnOutputTokens,
            sessionInputTokens: this.sessionInputTokens,
            sessionOutputTokens: this.sessionOutputTokens,
            tokensPerSecond:
                elapsed > 0
                    ? Math.round(this.turnOutputTokens / elapsed)
                    : 0,
            cacheHitTokens: this.turnCacheHitTokens,
            cacheMissTokens: this.turnCacheMissTokens,
        });
    }
}
