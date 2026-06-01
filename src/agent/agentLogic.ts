// src/agent/agentLogic.ts
import { useState, useRef } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import type { ToolRegistry } from "../tools/basetool.js";

// ── 历史记录类型 ──────────────────────────────────────────────

/** 一条展示用历史记录 */
export interface HistoryEntry {
    /** 唯一标识 */
    id: number;
    /** 条目类型，决定前端渲染颜色 */
    type: "thinking" | "tool_call" | "tool_result" | "answer";
    /** 展示文本 */
    content: string;
}

// ── 常量 ──────────────────────────────────────────────────────

const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个资深的 TypeScript 导师，可以使用工具来辅助回答。" },
];

// ── Hook ──────────────────────────────────────────────────────

export function useAgentLogic(registry: ToolRegistry, tools: OpenAI.Chat.Completions.ChatCompletionTool[]) {
    /** 仅用于 LLM 上下文的完整消息链 */
    const [messages, setMessages] = useState<OpenAI.Chat.ChatCompletionMessageParam[]>(INITIAL_MESSAGES);
    const [isThinking, setIsThinking] = useState(false);

    /** 当前轮次的流式文本（实时展示用） */
    const [streamText, setStreamText] = useState("");

    /** 展示用历史记录：每条记录独立存在，不折叠 */
    const [history, setHistory] = useState<HistoryEntry[]>([]);

    /** 自增 ID，保证每条记录的 key 稳定 */
    const historyIdRef = useRef(0);
    const pushHistory = (type: HistoryEntry["type"], content: string) => {
        const id = ++historyIdRef.current;
        setHistory((prev) => [...prev, { id, type, content }]);
    };

    const submitQuery = async (query: string) => {
        if (!query.trim()) return;

        const currentMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...messages,
            { role: "user", content: query },
        ];

        // 立即展示用户消息
        setMessages([...currentMessages]);
        setIsThinking(true);
        setStreamText("");
        setHistory([]); // 新一轮对话清空展示历史

        try {
            let result: SendResult;
            do {
                // ── 单轮 LLM 调用 + 流式输出 ──
                let currentStream = "";
                result = await sendMessage(currentMessages, {
                    tools,
                    onToken: (token) => {
                        currentStream += token;
                        setStreamText(currentStream);
                    },
                });

                // 流式结束：将最终内容固化为 answer 条目（白色）
                if (result.content) {
                    pushHistory("answer", result.content);
                }
                setStreamText("");

                // 推入 assistant 消息（给 LLM 上下文用）
                currentMessages.push({
                    role: "assistant",
                    content: result.content || null,
                    ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
                });

                // ── 工具调用 ──
                if (result.toolCalls?.length) {
                    for (const tc of result.toolCalls) {
                        // 工具调用记录（绿色）
                        pushHistory(
                            "tool_call",
                            `${tc.function.name}(${tc.function.arguments})`,
                        );

                        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        const toolResult = await registry.execute(tc.function.name, args);

                        // 工具返回记录（灰色）
                        pushHistory("tool_result", toolResult);

                        currentMessages.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: toolResult,
                        });
                    }
                }

                // 每轮迭代仅一次 setMessages，减少终端重绘
                setMessages([...currentMessages]);
            } while (result.toolCalls?.length);
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
        /** LLM 上下文消息（保留供调试或扩展使用） */
        messages,
        isThinking,
        /** 当前流式文本，空字符串表示无活跃流 */
        streamText,
        /** 展示用历史记录：thinking=灰 / tool_call=绿 / tool_result=灰 / answer=白 */
        history,
        submitQuery,
    };
}
