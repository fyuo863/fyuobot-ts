// src/agent/agentLogic.ts
import { useState, useRef, useCallback } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import { estimateTokens, type TokenStats } from "../llm/tokens.js";
import type { Agent } from "./agent.js";
import { buildInitialMessages, buildAgentIdentity } from "./prompts.js";
import { CompressTool } from "../tools/compress-tool.js";
import { appendTurnToHistory } from "../tools/history-manager.js";

// ── 历史记录类型 ──────────────────────────────────────────────

export interface HistoryEntry {
    id: number;
    type: "thinking" | "tool_call" | "tool_result" | "answer" | "user" | "system";
    content: string;
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
    const [tokenStats, setTokenStats] = useState<TokenStats>({
        turnInputTokens: 0,
        turnOutputTokens: 0,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
        tokensPerSecond: 0,
    });

    // ── 对话轮次追踪（用于自动记录 HISTORY.md） ──────────
    const turnQueryRef = useRef("");
    const turnResponseRef = useRef("");
    const turnToolsRef = useRef<string[]>([]);

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
        });
    }, []);

    const [conversationId, setConversationId] = useState(0);

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
                    setThoughtStream(`🔧 准备执行工具: ${tc.function.name}...`);
                    pushHistory("tool_call", `${tc.function.name}(${tc.function.arguments})`);
                    // 追踪本轮使用的工具
                    turnToolsRef.current.push(tc.function.name);

                    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                    const toolResult = await agent.registry.execute(tc.function.name, args);

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
        turnToolsRef.current = [];

        // ── Token 统计：新一轮开始 ──
        const inputTokens = estimateTokens(query);
        turnInputTokensRef.current = inputTokens;
        turnOutputTokensRef.current = 0;
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
                appendTurnToHistory({
                    query: turnQueryRef.current,
                    response: turnResponseRef.current,
                    tools: [...turnToolsRef.current],
                }).catch((e) =>
                    console.warn("[history] 记录失败:", e instanceof Error ? e.message : String(e)),
                );
            }

            // ── 被动触发：自动检测 + 处理超阈值文件 ──
            CompressTool.autoCompress().then((logs) => {
                for (const log of logs) {
                    console.log(`  ${log}`);
                }
            });
        }
    };

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
    };
}