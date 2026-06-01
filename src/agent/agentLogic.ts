// src/agent/useAgentLogic.ts
import { useState } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js"; // 注意 ESM 规范的 .js 后缀 [cite: 18]
import type { SendResult } from "../llm/llm.js";
import type { ToolRegistry } from "../tools/basetool.js";

const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个资深的 TypeScript 导师，可以使用工具来辅助回答。" },
];

export function useAgentLogic(registry: ToolRegistry, tools: OpenAI.Chat.Completions.ChatCompletionTool[]) {
    // 统一管理所有的底层逻辑状态
    const [messages, setMessages] = useState<OpenAI.Chat.ChatCompletionMessageParam[]>(INITIAL_MESSAGES);
    const [isThinking, setIsThinking] = useState(false);
    const [streamText, setStreamText] = useState("");
    const [toolLogs, setToolLogs] = useState<string[]>([]);

    // 核心调用逻辑
    const submitQuery = async (query: string) => {
        if (!query.trim()) return;

        const currentMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...messages,
            { role: "user", content: query }
        ];
        
        setMessages([...currentMessages]);
        setIsThinking(true);
        setToolLogs([]);
        setStreamText("");

        try {
            let result: SendResult;
            do {
                let currentStream = "";
                result = await sendMessage(currentMessages, {
                    tools,
                    onToken: (token) => {
                        currentStream += token;
                        setStreamText(currentStream); 
                    },
                });

                setStreamText("");
                currentMessages.push({
                    role: "assistant",
                    content: result.content || null,
                    ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
                });
                setMessages([...currentMessages]);

                if (result.toolCalls?.length) {
                    for (const tc of result.toolCalls) {
                        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        setToolLogs(prev => [...prev, `🔧 调用工具: ${tc.function.name}(${tc.function.arguments})`]);
                        
                        const toolResult = await registry.execute(tc.function.name, args);
                        setToolLogs(prev => [...prev, `✅ 工具返回: ${toolResult}`]);

                        currentMessages.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: toolResult,
                        });
                    }
                    setMessages([...currentMessages]); 
                }
            } while (result.toolCalls?.length);

        } catch (error) {
            setToolLogs(prev => [...prev, `❌ 错误: ${error instanceof Error ? error.message : String(error)}`]);
        } finally {
            setIsThinking(false);
        }
    };

    // 暴露出 UI 需要使用的数据和方法
    return {
        messages,
        isThinking,
        streamText,
        toolLogs,
        submitQuery
    };
}