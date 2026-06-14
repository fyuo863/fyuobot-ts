// src/agent/agent-task.ts
//
// AgentTask —— 从 Agent.runTask() 提取的 LLM 工具调用循环。
//
// 运行一个完整的 Agent 对话轮次：LLM 调用 → 工具执行 → 重复，
// 直到 LLM 在响应中不再请求工具调用。
//
// 所有可观察事件（token、工具调用、进度等）通过 MessageQueue 发出。
// runAgentTask 返回最终响应文本及更新后的上下文。

import type OpenAI from "openai";
import type { SendResult } from "../llm/llm.js";
import { sendMessage } from "../llm/llm.js";
import { estimateTokens } from "../llm/tokens.js";
import { detectProvider, normalizeUsage } from "../middleware/index.js";
import type { NormalizedUsage } from "../middleware/types.js";
import { AgentEventType, EventPriority, getEventPriority } from "./events.js";
import type {
    LlmRequestStartEvent,
    LlmTokenEvent,
    LlmToolCallsReceivedEvent,
    LlmResponseCompleteEvent,
    LlmErrorEvent,
    TaskStartEvent,
    TaskStepEvent,
    TaskCompleteEvent,
    TaskErrorEvent,
    StreamThinkingEvent,
    StreamAnswerEvent,
    TokenStatsUpdateEvent,
    ToolExecutionCompleteEvent,
} from "./events.js";
import type { TokenStats } from "../llm/tokens.js";
import type { MessageQueue } from "./message-queue.js";
import type { ToolRegistry } from "../tools/basetool.js";
import { executeToolBatch } from "./tool-executor.js";
import type { ToolCallRecord } from "../memory/history-manager.js";
import {
    appendRuntimeLog,
    hashDebugValue,
    logPromptDebug,
} from "../config/app-config.js";

// ── 类型 ──────────────────────────────────────────────────────

/** runAgentTask 的输入选项 */
export interface AgentTaskOptions {
    /** 工具注册中心（用于获取 OpenAI 工具定义和执行工具） */
    registry: ToolRegistry;
    /** 事件总线的直接引用（用于发出事件） */
    bus: MessageQueue;
    /** 初始 LLM 上下文消息数组（将就地修改） */
    context: OpenAI.Chat.ChatCompletionMessageParam[];
    /** 当前对话轮次的唯一关联 ID */
    turnId: string;
    /**
     * 确认函数 —— 当工具标记为 dangerous 时调用。
     * 应返回一个 Promise，在用户做出决定后解析。
     */
    confirmFn: (
        toolCallId: string,
        toolName: string,
        args: Record<string, unknown>,
    ) => Promise<{ approved: boolean; feedback?: string }>;
    /** 可选 —— 覆盖默认模型（用于子 Agent 等场景） */
    model?: string;
    /** 可选 —— 取消当前轮 LLM/工具循环。 */
    signal?: AbortSignal;
    /** 是否发出细粒度 token 事件（默认 true） */
    emitTokenEvents?: boolean;
    /** 是否发出流式 thinking / answer 事件（默认 true） */
    emitStreamingEvents?: boolean;
    /** 是否发出 token 统计事件（默认 true） */
    emitTokenStats?: boolean;
    /** 流式内容刷新间隔（默认 50ms） */
    streamFlushMs?: number;
}

/** runAgentTask 的返回值 */
export interface AgentTaskResult {
    /** 最终响应文本 */
    finalContent: string;
    /** 此轮次中总工具调用次数 */
    totalToolCalls: number;
    /** 总 LLM 调用次数 */
    totalLlmCalls: number;
    /** 任务耗时 (ms) */
    elapsedMs: number;
    /** 工具调用记录（用于 history.db） */
    toolCallRecords: ToolCallRecord[];
}

export class AgentTaskInterruptedError extends Error {
    readonly partialContent: string;

    constructor(partialContent: string) {
        super("Agent task interrupted.");
        this.name = "AgentTaskInterruptedError";
        this.partialContent = partialContent;
    }
}

function toModelToolContent(toolName: string, toolResult: string): string {
    if (toolName === "terminal_qrcode") {
        const linkLine = toolResult
            .split("\n")
            .find((line) => line.startsWith("链接: "));
        const link = linkLine?.slice("链接: ".length).trim();

        return link
            ? `二维码已在终端成功渲染。目标链接: ${link}`
            : "二维码已在终端成功渲染。";
    }

    return toolResult;
}

// ── 运行任务 ──────────────────────────────────────────────────

/**
 * 运行完整的 Agent 对话轮次。
 *
 * 内部循环：
 * ```
 * emit TASK_START
 * do {
 *   emit LLM_REQUEST_START
 *   result = await sendMessage(context, { tools, onToken })
 *   解析 <think> 标签
 *   emit STREAM_THINKING / STREAM_ANSWER
 *   emit LLM_RESPONSE_COMPLETE
 *   emit TOKEN_STATS_UPDATE
 *
 *   if (result.toolCalls?.length) {
 *     emit LLM_TOOL_CALLS_RECEIVED
 *     results = await executeToolBatch(...)
 *     // ^ 并行执行安全工具，顺序执行危险工具
 *     for each result:
 *       推入工具消息到 context
 *       emit TOOL_EXECUTION_COMPLETE
 *   }
 * } while (toolCalls?.length)
 * emit TASK_COMPLETE
 * ```
 *
 * @returns 最终内容、统计数据和更新后的上下文
 */
export async function runAgentTask(
    options: AgentTaskOptions,
): Promise<AgentTaskResult> {
    const { registry, bus, context, turnId, confirmFn } = options;
    const emitTokenEvents = options.emitTokenEvents ?? true;
    const emitStreamingEvents = options.emitStreamingEvents ?? true;
    const emitTokenStats = options.emitTokenStats ?? true;
    const streamFlushMs = options.streamFlushMs ?? 50;

    const tools = registry.toOpenAITools();
    logPromptDebug("runAgentTask.start", {
        turnId,
        contextSize: context.length,
        contextHash: hashDebugValue(context),
        toolsCount: tools.length,
        toolsHash: hashDebugValue(tools),
        model: options.model,
    });
    appendRuntimeLog("turn.start", {
        turnId,
        contextSize: context.length,
        contextHash: hashDebugValue(context),
        context,
        toolsCount: tools.length,
        toolsHash: hashDebugValue(tools),
        tools,
        model: options.model ?? null,
    });
    const turnStart = Date.now();
    let totalToolCalls = 0;
    let totalLlmCalls = 0;
    let finalContent = "";
    let currentStreamText = "";
    const toolCallRecords: ToolCallRecord[] = [];

    // 发出任务开始
    const taskStartEvent: TaskStartEvent = {
        type: AgentEventType.TASK_START,
        turnId,
        query: "", // 将由调用方通过上下文中的用户消息隐式填充
        timestamp: turnStart,
    };
    bus.enqueue(taskStartEvent, getEventPriority(AgentEventType.TASK_START));

    // ── Token 统计跟踪 ──────────────────────────────────
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let turnCacheHitTokens = 0;
    let turnCacheMissTokens = 0;
    // 注意：sessionInputTokens / sessionOutputTokens 由调用方管理

    try {
        let result: SendResult;

        do {
            throwIfAborted(options.signal, finalContent);
            totalLlmCalls++;

            // 发出 LLM 请求开始
            const llmStartEvent: LlmRequestStartEvent = {
                type: AgentEventType.LLM_REQUEST_START,
                turnId,
                contextSize: context.length,
                llmCallIndex: totalLlmCalls,
            };
            bus.enqueue(
                llmStartEvent,
                getEventPriority(AgentEventType.LLM_REQUEST_START),
            );

            // 发出任务步骤
            const stepEvent: TaskStepEvent = {
                type: AgentEventType.TASK_STEP,
                turnId,
                stepIndex: totalLlmCalls,
                action: `LLM 调用 #${totalLlmCalls}`,
            };
            bus.enqueue(
                stepEvent,
                getEventPriority(AgentEventType.TASK_STEP),
            );

            // 流文本累积
            let streamText = "";
            currentStreamText = "";
            let lastFlushTime = 0;

            // ── LLM 调用 ──────────────────────────────
            result = await sendMessage(context, {
                tools,
                ...(options.model !== undefined ? { model: options.model } : {}),
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                onToken: (token) => {
                    throwIfAborted(options.signal, streamText || finalContent);
                    streamText += token;
                    currentStreamText = streamText;

                    // 估算 token
                    turnOutputTokens += estimateTokens(token);

                    // 发出 LLM_TOKEN 事件
                    if (emitTokenEvents) {
                        const tokenEvent: LlmTokenEvent = {
                            type: AgentEventType.LLM_TOKEN,
                            turnId,
                            token,
                            cumulativeText: streamText,
                        };
                        bus.enqueue(
                            tokenEvent,
                            getEventPriority(AgentEventType.LLM_TOKEN),
                        );
                    }

                    // 按节流间隔发出流内容解析事件
                    const now = Date.now();
                    if (emitStreamingEvents && now - lastFlushTime >= streamFlushMs) {
                        flushStreamContent(streamText, bus, turnId);
                        lastFlushTime = now;
                    }
                },
            });
            throwIfAborted(options.signal, result.content || streamText || finalContent);

            // ── 解析最终文本中的 <think> 标签 ──────────
            const fullText = result.content || streamText || "";
            currentStreamText = fullText;
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

            // 发出最终的思考/回答流事件
            if (emitStreamingEvents && finalThink.trim()) {
                const thinkEvent: StreamThinkingEvent = {
                    type: AgentEventType.STREAM_THINKING,
                    turnId,
                    text: finalThink.trim(),
                };
                bus.enqueue(
                    thinkEvent,
                    getEventPriority(AgentEventType.STREAM_THINKING),
                );
            }
            if (emitStreamingEvents && finalNormal.trim()) {
                const answerEvent: StreamAnswerEvent = {
                    type: AgentEventType.STREAM_ANSWER,
                    turnId,
                    text: finalNormal.trim(),
                };
                bus.enqueue(
                    answerEvent,
                    getEventPriority(AgentEventType.STREAM_ANSWER),
                );
                finalContent = finalNormal.trim();
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

                turnInputTokens = normalized.promptTokens;
                if (normalized.completionTokens > 0) {
                turnOutputTokens = normalized.completionTokens;
                }
                turnCacheHitTokens = normalized.cacheHitTokens;
                turnCacheMissTokens = normalized.cacheMissTokens;

                logPromptDebug("runAgentTask.usage", {
                    provider,
                    usageHash: hashDebugValue(result.usage),
                    promptTokens: normalized.promptTokens,
                    completionTokens: normalized.completionTokens,
                    cacheHitTokens: normalized.cacheHitTokens,
                    cacheMissTokens: normalized.cacheMissTokens,
                });
                appendRuntimeLog("llm.usage", {
                    turnId,
                    provider,
                    rawUsage: result.usage,
                    normalizedUsage: normalized,
                });
            }

            // 发出 LLM 响应完成
            const llmCompleteEvent: LlmResponseCompleteEvent = {
                type: AgentEventType.LLM_RESPONSE_COMPLETE,
                turnId,
                content: result.content || "",
                thinkingContent: finalThink.trim(),
                usage: result.usage,
            };
            bus.enqueue(
                llmCompleteEvent,
                getEventPriority(AgentEventType.LLM_RESPONSE_COMPLETE),
            );

            // 发出 Token 统计更新
            const elapsed = turnStart
                ? (Date.now() - turnStart) / 1000
                : 0;
            const tokenStats: TokenStats = {
                turnInputTokens,
                turnOutputTokens,
                // session 级别的统计由调用方管理，这里只提供轮次级数据
                sessionInputTokens: 0,
                sessionOutputTokens: 0,
                tokensPerSecond:
                    elapsed > 0
                        ? Math.round(turnOutputTokens / elapsed)
                        : 0,
                cacheHitTokens: turnCacheHitTokens,
                cacheMissTokens: turnCacheMissTokens,
            };
            if (emitTokenStats) {
                const statsEvent: TokenStatsUpdateEvent = {
                    type: AgentEventType.TOKEN_STATS_UPDATE,
                    turnId,
                    stats: tokenStats,
                };
                bus.enqueue(
                    statsEvent,
                    getEventPriority(AgentEventType.TOKEN_STATS_UPDATE),
                );
            }

            // ── 追加 assistant 消息到上下文 ─────────────
            const assistantMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                role: "assistant",
                content: result.content || null,
                ...(result.toolCalls?.length
                    ? { tool_calls: result.toolCalls }
                    : {}),
            };
            context.push(assistantMsg);
            logPromptDebug("runAgentTask.context_after_assistant", {
                turnId,
                contextSize: context.length,
                contextHash: hashDebugValue(context),
                assistantContentLength: (result.content || "").length,
                assistantToolCallCount: result.toolCalls?.length ?? 0,
            });
            appendRuntimeLog("turn.context_after_assistant", {
                turnId,
                contextSize: context.length,
                contextHash: hashDebugValue(context),
                assistantMessage: assistantMsg,
            });

            // ── 工具调用 ──────────────────────────────
            if (result.toolCalls?.length) {
                throwIfAborted(options.signal, finalContent);
                // 发出工具调用已接收事件
                const parsedCalls = result.toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                    parsedArgs: JSON.parse(
                        tc.function.arguments,
                    ) as Record<string, unknown>,
                }));

                const toolCallsEvent: LlmToolCallsReceivedEvent = {
                    type: AgentEventType.LLM_TOOL_CALLS_RECEIVED,
                    turnId,
                    toolCalls: parsedCalls,
                };
                appendRuntimeLog("tool.calls_requested", {
                    turnId,
                    toolCalls: parsedCalls,
                });
                bus.enqueue(
                    toolCallsEvent,
                    getEventPriority(
                        AgentEventType.LLM_TOOL_CALLS_RECEIVED,
                    ),
                );

                // 执行工具批处理
                const batchItems = parsedCalls.map((tc) => ({
                    toolCallId: tc.id,
                    toolName: tc.name,
                    args: tc.parsedArgs,
                }));
                const argsByToolCallId = new Map(
                    batchItems.map((item) => [item.toolCallId, item.args]),
                );

                const batchResults = await executeToolBatch(
                    batchItems,
                    registry,
                    bus,
                    turnId,
                    confirmFn,
                );
                throwIfAborted(options.signal, finalContent);

                // 将结果推入上下文并记录
                for (const tcResult of batchResults) {
                    totalToolCalls++;

                    // 追踪用于 history.db
                    toolCallRecords.push({
                        name: tcResult.toolName,
                        args: argsByToolCallId.get(tcResult.toolCallId) ?? {},
                        result: tcResult.result,
                    });

                    // 追加工具消息到上下文
                    context.push({
                        role: "tool",
                        tool_call_id: tcResult.toolCallId,
                        content: toModelToolContent(
                            tcResult.toolName,
                            tcResult.result,
                        ),
                    });
                }

                // 为每个结果发出 TOOL_EXECUTION_COMPLETE
                // （注意：executeToolBatch 已经在内部发出这些事件，
                //   但我们需要为调用方保留事件流的一致性）
            }
        } while (result.toolCalls?.length);

        // ── 成功完成 ──────────────────────────────────
        const elapsedMs = Date.now() - turnStart;

        const completeEvent: TaskCompleteEvent = {
            type: AgentEventType.TASK_COMPLETE,
            turnId,
            finalContent: finalContent || "任务完成（无文本输出）",
            totalToolCalls,
            totalLlmCalls,
            elapsedMs,
        };
        bus.enqueue(
            completeEvent,
            getEventPriority(AgentEventType.TASK_COMPLETE),
        );
        appendRuntimeLog("turn.complete", {
            turnId,
            finalContent,
            totalToolCalls,
            totalLlmCalls,
            elapsedMs,
            toolCallRecords,
        });

        return {
            finalContent: finalContent || "任务完成（无文本输出）",
            totalToolCalls,
            totalLlmCalls,
            elapsedMs,
            toolCallRecords,
        };
    } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) {
            const partialContent = extractPartialContent(
                error,
                finalContent || currentStreamText,
            );
            persistInterruptedAssistantMessage(context, partialContent);
            throw new AgentTaskInterruptedError(partialContent);
        }

        // ── 错误 ──────────────────────────────────────
        const elapsedMs = Date.now() - turnStart;
        const errorMsg =
            error instanceof Error ? error.message : String(error);

        // 发出 LLM 错误事件
        const llmErrorEvent: LlmErrorEvent = {
            type: AgentEventType.LLM_ERROR,
            turnId,
            error: errorMsg,
            llmCallIndex: totalLlmCalls,
        };
        bus.enqueue(
            llmErrorEvent,
            getEventPriority(AgentEventType.LLM_ERROR),
        );

        // 发出任务错误事件
        const taskErrorEvent: TaskErrorEvent = {
            type: AgentEventType.TASK_ERROR,
            turnId,
            error: errorMsg,
            elapsedMs,
        };
        bus.enqueue(
            taskErrorEvent,
            getEventPriority(AgentEventType.TASK_ERROR),
        );
        appendRuntimeLog("turn.error", {
            turnId,
            error: errorMsg,
            elapsedMs,
            totalToolCalls,
            totalLlmCalls,
        });

        throw error;
    }
}

// ── 内部辅助 ──────────────────────────────────────────────────

/**
 * 解析当前流文本中的 `<think>` 标签，并发出相应的 STREAM_THINKING
 * 和 STREAM_ANSWER 事件。
 */
function throwIfAborted(
    signal: AbortSignal | undefined,
    partialContent: string,
): void {
    if (signal?.aborted) {
        throw new AgentTaskInterruptedError(partialContent);
    }
}

function isAbortError(error: unknown): boolean {
    if (error instanceof AgentTaskInterruptedError) return true;
    if (!(error instanceof Error)) return false;
    return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
}

function extractPartialContent(error: unknown, fallback: string): string {
    if (error instanceof AgentTaskInterruptedError) {
        return error.partialContent || fallback;
    }
    return fallback;
}

export function persistInterruptedAssistantMessage(
    context: OpenAI.Chat.ChatCompletionMessageParam[],
    partialContent: string,
): void {
    const content = partialContent.trim();
    const interruptedContent = content
        ? `${content}\n\n[interrupted by user]`
        : "[interrupted by user]";

    const lastAssistant = findLastAssistantInCurrentTurn(context);
    if (lastAssistant) {
        markAssistantInterrupted(lastAssistant, interruptedContent);
        appendInterruptedToolMessages(
            context,
            getAssistantToolCallIds(lastAssistant),
        );
        return;
    }

    context.push({
        role: "assistant",
        content: interruptedContent,
    });
}

function findLastAssistantInCurrentTurn(
    context: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam | undefined {
    const lastUserIndex = findLastRoleIndex(context, "user");
    for (let i = context.length - 1; i > lastUserIndex; i--) {
        const message = context[i];
        if (message?.role === "assistant") return message;
    }
    return undefined;
}

function findLastRoleIndex(
    context: OpenAI.Chat.ChatCompletionMessageParam[],
    role: OpenAI.Chat.ChatCompletionMessageParam["role"],
): number {
    for (let i = context.length - 1; i >= 0; i--) {
        if (context[i]?.role === role) return i;
    }
    return -1;
}

function markAssistantInterrupted(
    message: OpenAI.Chat.ChatCompletionMessageParam,
    interruptedContent: string,
): void {
    if (message.role !== "assistant") return;

    if (typeof message.content === "string" && message.content.trim()) {
        if (!message.content.includes("[interrupted by user]")) {
            message.content = `${message.content.trimEnd()}\n\n[interrupted by user]`;
        }
        return;
    }

    message.content = interruptedContent;
}

function getAssistantToolCallIds(
    message: OpenAI.Chat.ChatCompletionMessageParam,
): string[] {
    if (message.role !== "assistant") return [];

    const toolCalls = (message as { tool_calls?: Array<{ id?: string }> })
        .tool_calls;
    if (!Array.isArray(toolCalls)) return [];

    return toolCalls
        .map((toolCall) => toolCall.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function appendInterruptedToolMessages(
    context: OpenAI.Chat.ChatCompletionMessageParam[],
    toolCallIds: string[],
): void {
    const existingToolCallIds = new Set(
        context
            .filter((message) => message.role === "tool")
            .map((message) => message.tool_call_id),
    );

    for (const toolCallId of toolCallIds) {
        if (existingToolCallIds.has(toolCallId)) continue;
        context.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: "[interrupted by user before this tool call completed]",
        });
    }
}

function flushStreamContent(
    fullText: string,
    bus: MessageQueue,
    turnId: string,
): void {
    let thinkContent = "";
    let normalContent = fullText;

    const thinkStart = fullText.indexOf("<think>");
    if (thinkStart !== -1) {
        const thinkEnd = fullText.indexOf("</think>", thinkStart);
        if (thinkEnd !== -1) {
            thinkContent = fullText.substring(thinkStart + 7, thinkEnd);
            normalContent =
                fullText.substring(0, thinkStart) +
                fullText.substring(thinkEnd + 8);
        } else {
            thinkContent = fullText.substring(thinkStart + 7);
            normalContent = fullText.substring(0, thinkStart);
        }
    }

    if (thinkContent) {
        const thinkEvent: StreamThinkingEvent = {
            type: AgentEventType.STREAM_THINKING,
            turnId,
            text: thinkContent,
        };
        bus.enqueue(
            thinkEvent,
            getEventPriority(AgentEventType.STREAM_THINKING),
        );
    }
    if (normalContent) {
        const answerEvent: StreamAnswerEvent = {
            type: AgentEventType.STREAM_ANSWER,
            turnId,
            text: normalContent,
        };
        bus.enqueue(
            answerEvent,
            getEventPriority(AgentEventType.STREAM_ANSWER),
        );
    }
}
