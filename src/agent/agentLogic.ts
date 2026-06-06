// src/agent/agentLogic.ts
import { useState, useRef, useCallback } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import { estimateTokens, type TokenStats } from "../llm/tokens.js";
import type { Agent } from "./agent.js";
import { buildInitialMessages, buildAgentIdentity } from "./prompts.js";
import { HistoryManager, type ToolCallRecord } from "../memory/history-manager.js";
import { detectProvider, normalizeUsage } from "../middleware/index.js";
import type { NormalizedUsage } from "../middleware/types.js";

// ── 历史记录类型 ──────────────────────────────────────────────

export interface HistoryEntry {
    id: number;
    type: "thinking" | "tool_call" | "tool_result" | "answer" | "user" | "system";
    content: string;
}

/** 等待用户确认的敏感操作快照 */
export interface PendingConfirm {
    /** 工具名称 */
    toolName: string;
    /** 工具参数（已解析为对象） */
    toolArgs: Record<string, unknown>;
}

/** 用户对敏感操作的确认结果 */
export interface ConfirmResult {
    /** 是否批准执行 */
    approved: boolean;
    /** 用户自定义反馈：拒绝原因、替代命令、修改建议等（可选） */
    feedback?: string;
}

/**
 * 初始消息 —— 按缓存优化顺序排列（由稳定到易变）：
 *   1. Agent 身份（永不变 —— 缓存锚点）
 *   2. 用户偏好 USER.md（启动时自动读取）
 *   3. 系统设置 MEMORY.md（启动时自动读取）
 *   4. 核心系统提示词（工具描述与规则）
 * 后续用户消息会追加到此数组末尾。
 */
const DEFAULT_IDENTITY = buildAgentIdentity("fyuobot");

const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] =
    buildInitialMessages(DEFAULT_IDENTITY);

// ── Hook ──────────────────────────────────────────────────────

export function useAgentLogic(agent: Agent) {
    const [messages, setMessages] = useState<OpenAI.Chat.ChatCompletionMessageParam[]>(INITIAL_MESSAGES);
    
    // 引擎整体是否处于活跃状态（包含等待网络、调用工具等）
    const [isThinking, setIsThinking] = useState(false);
    // 引擎是否正在流式输出最终给用户的回答（用于触发 UI 的自适应 Markdown 框）
    const [isAnswering, setIsAnswering] = useState(false);

    // 动态流内容拆分
    const [thoughtStream, setThoughtStream] = useState("");
    const [answerStream, setAnswerStream] = useState("");

    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const historyIdRef = useRef(0);
    
    const pushHistory = (type: HistoryEntry["type"], content: string) => {
        const id = ++historyIdRef.current;
        setHistory((prev) => [...prev, { id, type, content }]);
    };

    const streamTextRef = useRef("");
    const lastStreamFlushRef = useRef(0);
    const STREAM_FLUSH_MS = 50;

    // ── Token 统计（实时） ──────────────────────────────────
    const turnInputTokensRef = useRef(0);
    const turnOutputTokensRef = useRef(0);
    const sessionInputTokensRef = useRef(0);
    const sessionOutputTokensRef = useRef(0);
    const turnStartRef = useRef(0);
    const turnCacheHitTokensRef = useRef(0);
    const turnCacheMissTokensRef = useRef(0);

    // ── 敏感操作确认 ──────────────────────────────────────
    const confirmResolverRef = useRef<(result: ConfirmResult) => void>(undefined);
    const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
    const [tokenStats, setTokenStats] = useState<TokenStats>({
        turnInputTokens: 0,
        turnOutputTokens: 0,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
        tokensPerSecond: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
    });

    // ── 对话轮次追踪（用于自动记录 HISTORY.md） ──────────
    const turnQueryRef = useRef("");
    const turnResponseRef = useRef("");
    const turnToolCallsRef = useRef<ToolCallRecord[]>([]);

    const flushTokenStats = useCallback(() => {
        const elapsed = turnStartRef.current
            ? (Date.now() - turnStartRef.current) / 1000
            : 0;
        setTokenStats({
            turnInputTokens: turnInputTokensRef.current,
            turnOutputTokens: turnOutputTokensRef.current,
            sessionInputTokens: sessionInputTokensRef.current,
            sessionOutputTokens: sessionOutputTokensRef.current,
            tokensPerSecond:
                elapsed > 0
                    ? Math.round(turnOutputTokensRef.current / elapsed)
                    : 0,
            cacheHitTokens: turnCacheHitTokensRef.current,
            cacheMissTokens: turnCacheMissTokensRef.current,
        });
    }, []);

    const [conversationId, setConversationId] = useState(0);

    // ── 敏感操作确认 ──────────────────────────────────────

    /** 发起确认请求，返回 Promise 在用户选择后 resolve */
    const requestConfirm = useCallback(
        (toolName: string, toolArgs: Record<string, unknown>): Promise<ConfirmResult> =>
            new Promise(resolve => {
                confirmResolverRef.current = resolve;
                setPendingConfirm({ toolName, toolArgs });
            }),
        [],
    );

    /** 用户做出选择后调用 */
    const resolveConfirm = useCallback((result: ConfirmResult) => {
        confirmResolverRef.current?.(result);
        confirmResolverRef.current = undefined;
        setPendingConfirm(null);
    }, []);

    // ── 内部：运行 LLM 工具调用循环 ──────────────────────────

    const runLLMTurn = async (
        contextMessages: OpenAI.Chat.ChatCompletionMessageParam[],
    ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> => {
        const newMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        const tools = agent.registry.toOpenAITools();

        let result: SendResult;
        do {
            // 每轮重置流状态
            setThoughtStream("⏳ 正在思考...");
            setIsAnswering(false);
            setAnswerStream("");
            streamTextRef.current = "";

            result = await sendMessage(contextMessages, {
                tools,
                onToken: (token) => {
                    streamTextRef.current += token;
                    // 实时 token 计数
                    turnOutputTokensRef.current += estimateTokens(token);
                    sessionOutputTokensRef.current += estimateTokens(token);
                    const now = Date.now();
                    if (now - lastStreamFlushRef.current >= STREAM_FLUSH_MS) {
                        const fullText = streamTextRef.current;
                        let thinkContent = "";
                        let normalContent = fullText;

                        // 实时解析 <think> 标签 (兼容 DeepSeek 等模型)
                        const thinkStart = fullText.indexOf("<think>");
                        if (thinkStart !== -1) {
                            const thinkEnd = fullText.indexOf("</think>", thinkStart);
                            if (thinkEnd !== -1) {
                                thinkContent = fullText.substring(thinkStart + 7, thinkEnd);
                                normalContent = fullText.substring(0, thinkStart) + fullText.substring(thinkEnd + 8);
                            } else {
                                thinkContent = fullText.substring(thinkStart + 7);
                                normalContent = fullText.substring(0, thinkStart);
                            }
                        }

                        // 分发至 UI 对应的流式状态
                        if (thinkContent) setThoughtStream(thinkContent);
                        if (normalContent) {
                            setAnswerStream(normalContent);
                            setIsAnswering(true);
                        }
                        
                        lastStreamFlushRef.current = now;
                        flushTokenStats();
                    }
                },
            });

            // ── 处理流结束的收尾逻辑 ──
            const fullText = result.content || streamTextRef.current || "";
            let finalThink = "";
            let finalNormal = fullText;

            const thinkStart = fullText.indexOf("<think>");
            if (thinkStart !== -1) {
                const thinkEnd = fullText.indexOf("</think>", thinkStart);
                if (thinkEnd !== -1) {
                    finalThink = fullText.substring(thinkStart + 7, thinkEnd);
                    finalNormal = fullText.substring(0, thinkStart) + fullText.substring(thinkEnd + 8);
                } else {
                    finalThink = fullText.substring(thinkStart + 7);
                    finalNormal = fullText.substring(0, thinkStart);
                }
            }

            // 将截获的最终文本推入静态账本
            if (finalThink.trim()) {
                pushHistory("thinking", finalThink.trim());
            }
            if (finalNormal.trim()) {
                pushHistory("answer", finalNormal.trim());
                // 捕获最终响应文本（取最后一次非空响应）
                turnResponseRef.current = finalNormal.trim();
            }

            // 清理动态 UI 状态
            setThoughtStream("");
            setAnswerStream("");
            setIsAnswering(false);

            // ── Token 协调：用 API 返回的真实 usage 替换估算值 ──
            if (result.usage) {
                const provider = detectProvider(process.env.THIRD_PARTY_BASE_URL);
                const normalized: NormalizedUsage = normalizeUsage(provider, result.usage);

                // 记录当前估算值（用于修正会话总计）
                const estimatedInput = turnInputTokensRef.current;
                const estimatedOutput = turnOutputTokensRef.current;

                // 用 API 权威值替换本轮计数
                if (normalized.promptTokens > 0) {
                    turnInputTokensRef.current = normalized.promptTokens;
                    sessionInputTokensRef.current += normalized.promptTokens - estimatedInput;
                }
                if (normalized.completionTokens > 0) {
                    turnOutputTokensRef.current = normalized.completionTokens;
                    sessionOutputTokensRef.current += normalized.completionTokens - estimatedOutput;
                }

                // 缓存命中/未命中（仅 API 能提供）
                turnCacheHitTokensRef.current = normalized.cacheHitTokens;
                turnCacheMissTokensRef.current = normalized.cacheMissTokens;

                flushTokenStats();
            }

            const assistantMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                role: "assistant",
                content: result.content || null,
                ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
            };
            contextMessages.push(assistantMsg);
            newMessages.push(assistantMsg);

            // ── 工具调用 ──
            if (result.toolCalls?.length) {
                for (const tc of result.toolCalls) {
                    const toolName = tc.function.name;
                    const toolArgsStr = tc.function.arguments;
                    const args = JSON.parse(toolArgsStr) as Record<string, unknown>;

                    setThoughtStream(`🔧 准备执行工具: ${toolName}...`);
                    pushHistory("tool_call", `${toolName}(${toolArgsStr})`);

                    // ── 追踪本轮工具调用（用于记录到 HISTORY.md）──
                    const callRecord: ToolCallRecord = {
                        name: toolName,
                        args,
                        result: "",
                    };
                    turnToolCallsRef.current.push(callRecord);

                    // ── 敏感操作确认 ──
                    const tool = agent.registry.get(toolName);
                    if (tool?.dangerous) {
                        setThoughtStream(`⏸️ 敏感操作确认中: ${toolName}`);
                        const confirm = await requestConfirm(toolName, args);
                        if (!confirm.approved) {
                            const feedback = confirm.feedback
                                ? `\n[用户反馈]: ${confirm.feedback}`
                                : "\n[用户反馈]: 用户拒绝了此操作，没有提供额外说明";
                            const cancelMsg =
                                `❌ 用户拒绝了敏感操作: ${toolName}\n` +
                                `[原始参数]: ${toolArgsStr}${feedback}\n` +
                                `[提示]: 请根据用户反馈调整操作方案，如需执行替代命令请在下次调用时修改参数`;
                            pushHistory("tool_result", cancelMsg);
                            callRecord.result = cancelMsg;
                            const toolMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                                role: "tool",
                                tool_call_id: tc.id,
                                content: cancelMsg,
                            };
                            contextMessages.push(toolMsg);
                            newMessages.push(toolMsg);
                            continue;
                        }
                        setThoughtStream(`🔧 准备执行工具: ${toolName}...`);
                    }

                    // 带进度回调的工具执行 —— 实时更新 thoughtStream
                    const toolResult = await agent.registry.execute(
                        toolName,
                        args,
                        (progress: string) => {
                            setThoughtStream(`🔧 ${toolName}: ${progress}`);
                        },
                    );

                    // 更新记录的结果
                    callRecord.result = toolResult;

                    // 工具执行完成后，将摘要记录到 UI 历史
                    const summary =
                        toolResult.length > 500
                            ? toolResult.slice(0, 500) + "\n... (已截断)"
                            : toolResult;
                    pushHistory("tool_result", summary);

                    const toolMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                        role: "tool",
                        tool_call_id: tc.id,
                        content: toolResult,
                    };
                    contextMessages.push(toolMsg);
                    newMessages.push(toolMsg);
                }
            }

            setMessages([...contextMessages]);
        } while (result.toolCalls?.length);

        return newMessages;
    };

    // ── 公开接口 ────────────────────────────────────────────

    const submitQuery = async (query: string) => {
        if (!query.trim()) return;

        // ── 轮次追踪：记录用户查询，清空上一轮数据 ──
        turnQueryRef.current = query.trim();
        turnResponseRef.current = "";
        turnToolCallsRef.current = [];

        // ── Token 统计：新一轮开始 ──
        const inputTokens = estimateTokens(query);
        turnInputTokensRef.current = inputTokens;
        turnOutputTokensRef.current = 0;
        turnCacheHitTokensRef.current = 0;
        turnCacheMissTokensRef.current = 0;
        sessionInputTokensRef.current += inputTokens;
        turnStartRef.current = Date.now();
        flushTokenStats();

        const contextMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...messages,
            { role: "user", content: query },
        ];

        setMessages([...contextMessages]);
        setIsThinking(true);
        setIsAnswering(false);
        setThoughtStream("");
        setAnswerStream("");
        lastStreamFlushRef.current = 0;
        streamTextRef.current = "";
        setConversationId((prev) => prev + 1);
        setHistory([]);
        pushHistory("user", query);

        try {
            await runLLMTurn(contextMessages);
        } catch (error) {
            pushHistory(
                "tool_result",
                `❌ 错误: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            // 最终刷新 token 统计（确保 t/s 为整轮平均值）
            flushTokenStats();
            setIsThinking(false);

            // ── 被动全量记录：自动追加对话到 HISTORY.md ──
            if (turnQueryRef.current && turnResponseRef.current) {
                try {
                    HistoryManager.instance().saveTurn(
                        "",
                        turnQueryRef.current,
                        turnResponseRef.current,
                        turnToolCallsRef.current.length > 0
                            ? turnToolCallsRef.current
                            : undefined,
                    );
                } catch (e) {
                    console.warn(
                        "[history] 记录失败:",
                        e instanceof Error ? e.message : String(e),
                    );
                }
            }

            // ── 被动触发：自动检测 + 处理超阈值 HISTORY.md ──
            HistoryManager.instance().checkAndCondense();
        }
    };

    /** 重置对话上下文：清空消息历史、Token 统计、UI 状态 */
    const resetConversation = useCallback(() => {
        setMessages([...INITIAL_MESSAGES]);
        setHistory([]);
        historyIdRef.current = 0;
        streamTextRef.current = "";
        setThoughtStream("");
        setAnswerStream("");
        setIsThinking(false);
        setIsAnswering(false);
        // Token 统计归零
        turnInputTokensRef.current = 0;
        turnOutputTokensRef.current = 0;
        sessionInputTokensRef.current = 0;
        sessionOutputTokensRef.current = 0;
        turnStartRef.current = 0;
        turnCacheHitTokensRef.current = 0;
        turnCacheMissTokensRef.current = 0;
        flushTokenStats();
        // 新对话 ID，触发 UI 的 processedHistoryIds 清理
        setConversationId((prev) => prev + 1);
        // 开始新的 HistoryManager 会话（延迟到下次用户输入时写入头部）
        HistoryManager.instance().startNewSession();
    }, [flushTokenStats]);

    return {
        messages,
        isThinking,
        isAnswering,
        thoughtStream,
        answerStream,
        history,
        conversationId,
        tokenStats,
        submitQuery,
        pendingConfirm,
        resolveConfirm,
        resetConversation,
    };
}