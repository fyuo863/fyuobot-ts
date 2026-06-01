// src/agent/useAgentLogic.ts
import { useState } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import type { ToolRegistry } from "../tools/basetool.js";

const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个资深的 TypeScript 导师，可以使用工具来辅助回答。" },
];

export function useAgentLogic(registry: ToolRegistry, tools: OpenAI.Chat.Completions.ChatCompletionTool[]) {
    const [messages, setMessages] = useState<OpenAI.Chat.ChatCompletionMessageParam[]>(INITIAL_MESSAGES);
    const [isThinking, setIsThinking] = useState(false);
    const [streamText, setStreamText] = useState("");
    const [toolLogs, setToolLogs] = useState<string[]>([]);

    const submitQuery = async (query: string) => {
        if (!query.trim()) return;

        const currentMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...messages,
            { role: "user", content: query },
        ];

        // 立即展示用户消息
        setMessages([...currentMessages]);
        setIsThinking(true);
        setToolLogs([]);
        setStreamText("");

        try {
            let result: SendResult;
            do {
                // ---- 单轮 LLM 调用 + 流式输出 ----
                let currentStream = "";
                result = await sendMessage(currentMessages, {
                    tools,
                    onToken: (token) => {
                        currentStream += token;
                        setStreamText(currentStream);
                    },
                });

                setStreamText("");

                // 推入 assistant 消息
                currentMessages.push({
                    role: "assistant",
                    content: result.content || null,
                    ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
                });

                // 如果有工具调用，批量执行并收集日志
                if (result.toolCalls?.length) {
                    const newLogs: string[] = [];

                    for (const tc of result.toolCalls) {
                        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        newLogs.push(`🔧 调用工具: ${tc.function.name}(${tc.function.arguments})`);

                        const toolResult = await registry.execute(tc.function.name, args);
                        newLogs.push(`✅ 工具返回: ${toolResult}`);

                        currentMessages.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: toolResult,
                        });
                    }

                    // 批量写入日志，减少渲染次数
                    setToolLogs((prev) => [...prev, ...newLogs]);
                }

                // 每轮迭代仅一次 setMessages，减少终端重绘
                setMessages([...currentMessages]);
            } while (result.toolCalls?.length);
        } catch (error) {
            setToolLogs((prev) => [
                ...prev,
                `❌ 错误: ${error instanceof Error ? error.message : String(error)}`,
            ]);
        } finally {
            setIsThinking(false);
        }
    };

    return {
        messages,
        isThinking,
        streamText,
        toolLogs,
        submitQuery,
    };
}
