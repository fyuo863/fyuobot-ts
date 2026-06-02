// src/agent/agentLogic.ts
import { useState, useRef } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import type { Agent } from "./agent.js";
import { CORE_SYSTEM_PROMPT, buildAgentIdentity } from "./prompts.js";

// ── 历史记录类型 ──────────────────────────────────────────────

export interface HistoryEntry {
    id: number;
    type: "thinking" | "tool_call" | "tool_result" | "answer" | "user" | "system";
    content: string;
}

/**
 * 初始消息 —— 按缓存优化顺序排列：
 *   1. 核心系统提示词（Layer 1, 缓存前缀）
 *   2. Agent 身份（Layer 2）
 * 后续用户消息会追加到此数组末尾。
 */
const DEFAULT_IDENTITY = buildAgentIdentity("fyuobot");

const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: CORE_SYSTEM_PROMPT },
    { role: "system", content: DEFAULT_IDENTITY },
];

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
            setIsThinking(false);
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
        submitQuery,
    };
}