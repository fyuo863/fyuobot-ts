import React, { useState } from "react";
import { render, Box, Text } from "ink";
import TextInput from "ink-text-input";
import { fileURLToPath } from "url";
import type OpenAI from "openai";

import { ToolRegistry } from "../tools/basetool.js";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";

// 初始系统提示词
const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
        role: "system",
        content: "你是一个资深的 TypeScript 导师，可以使用工具来辅助回答。"
    },
];

interface AgentAppProps {
    registry: ToolRegistry;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
}

function AgentApp({ registry, tools }: AgentAppProps) {
    // UI 状态管理
    const [messages, setMessages] = useState<OpenAI.Chat.ChatCompletionMessageParam[]>(INITIAL_MESSAGES);
    const [input, setInput] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const [streamText, setStreamText] = useState("");
    const [toolLogs, setToolLogs] = useState<string[]>([]);

    const handleSubmit = async (query: string) => {
        if (!query.trim()) return;

        // 1. 准备局部上下文变量，避免 React state 异步更新导致丢失历史记录
        const currentMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...messages,
            { role: "user", content: query }
        ];
        
        // 2. 更新 UI 状态
        setMessages([...currentMessages]);
        setInput("");
        setIsThinking(true);
        setToolLogs([]);
        setStreamText("");

        try {
            let result: SendResult;

            // ---- 工具调用循环：兼容 LLM 连续多次请求工具 ----
            do {
                let currentStream = "";
                
                // 发起请求并处理流式输出
                result = await sendMessage(currentMessages, {
                    tools,
                    onToken: (token) => {
                        currentStream += token;
                        setStreamText(currentStream); // 实时更新流式 UI
                    },
                });

                // 回复结束后，清空流状态，并将完整消息推入局部上下文
                setStreamText("");
                currentMessages.push({
                    role: "assistant",
                    content: result.content || null,
                    ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
                });
                setMessages([...currentMessages]); // 同步给 UI

                // 处理工具调用
                if (result.toolCalls?.length) {
                    for (const tc of result.toolCalls) {
                        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        
                        // 更新 UI 提示正在调用工具
                        setToolLogs(prev => [...prev, `🔧 正在调用工具: ${tc.function.name}(${tc.function.arguments})`]);
                        
                        // 执行本地工具
                        const toolResult = await registry.execute(tc.function.name, args);
                        
                        // 更新 UI 提示工具返回结果
                        setToolLogs(prev => [...prev, `✅ 工具返回: ${toolResult}`]);

                        // 将工具结果推入局部上下文
                        currentMessages.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: toolResult,
                        });
                    }
                    setMessages([...currentMessages]); // 再次同步给 UI
                }

            } while (result.toolCalls?.length);

        } catch (error) {
            setToolLogs(prev => [...prev, `❌ 错误: ${error instanceof Error ? error.message : String(error)}`]);
        } finally {
            setIsThinking(false);
        }
    };

    return (
        <Box flexDirection="column" padding={1}>
            {/* 顶部标题栏 */}
            <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
                <Text color="cyan" bold>🤖 TS 导师 Agent (已加载 {registry.size} 个工具)</Text>
            </Box>

            {/* 历史对话展示区 */}
            <Box flexDirection="column" marginBottom={1}>
                {messages.map((msg, index) => {
                    if (msg.role === "system") return null; // 隐藏 system prompt
                    if (msg.role === "tool") return null;   // 隐藏纯数据的 tool 回复（使用 toolLogs 展示）
                    
                    // 隐藏只有 tool_calls 没有 content 的助手消息
                    if (msg.role === "assistant" && !msg.content) return null;

                    return (
                        <Text key={index} color={msg.role === "user" ? "green" : "white"}>
                            <Text bold>{msg.role === "user" ? "🧑 你: " : "🤖 AI: "}</Text>
                            {String(msg.content)}
                        </Text>
                    );
                })}

                {/* 实时流式打字机输出展示 */}
                {streamText && (
                    <Text color="white">
                        <Text bold>🤖 AI: </Text>{streamText}
                    </Text>
                )}
            </Box>

            {/* 工具调用日志展示 */}
            {toolLogs.length > 0 && (
                <Box flexDirection="column" marginBottom={1} paddingLeft={2} borderLeftColor="yellow" borderStyle="single" borderTop={false} borderRight={false} borderBottom={false}>
                    {toolLogs.map((log, index) => (
                        <Text key={`log-${index}`} color="gray">{log}</Text>
                    ))}
                </Box>
            )}

            {/* 底部输入区 / 加载状态 */}
            {isThinking ? (
                <Text color="yellow">⏳ 脑电波运转中，请稍候...</Text>
            ) : (
                <Box>
                    <Text color="green" bold>✏️ 提问: </Text>
                    <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
                </Box>
            )}
            <Text color="gray" dimColor> (输入完成后按 Enter 发送，按 Ctrl+C 退出)</Text>
        </Box>
    );
}

/**
 * 启动引导程序
 * 负责扫描工具并渲染 Ink UI
 */
async function bootstrap() {
    try {
        const registry = await ToolRegistry.discoverAndRegister(
            new URL("../tools", import.meta.url),
        );
        const tools = registry.toOpenAITools();

        // 启动 React Ink 渲染
        render(<AgentApp registry={registry} tools={tools} />);
    } catch (error) {
        console.error("启动失败:", error);
    }
}

// 直接运行时启动
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}