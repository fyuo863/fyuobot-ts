// src/agent/AgentUI.tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";

import type { ToolRegistry } from "../tools/basetool.js";
import { useAgentLogic } from "../agent/agentLogic.js"; 

interface AgentUIProps {
    registry: ToolRegistry;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
}

export function AgentUI({ registry, tools }: AgentUIProps) {
    // 1. 调用逻辑模块，获取状态和操作方法
    const { messages, isThinking, streamText, toolLogs, submitQuery } = useAgentLogic(registry, tools);
    
    // UI 层只维护自己的细粒度状态（比如当前输入框的文字）
    const [input, setInput] = useState("");

    const handleSubmit = () => {
        submitQuery(input); // 将用户的输入交给逻辑层去处理
        setInput("");       // 清空输入框
    };

    return (
        <Box flexDirection="column" padding={1}>
            <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
                <Text color="cyan" bold>🤖 TS 导师 Agent (已加载 {registry.size} 个工具)</Text>
            </Box>

            <Box flexDirection="column" marginBottom={1}>
                {messages.map((msg, index) => {
                    if (msg.role === "system" || msg.role === "tool") return null;
                    if (msg.role === "assistant" && !msg.content) return null;

                    return (
                        <Text key={index} color={msg.role === "user" ? "green" : "white"}>
                            <Text bold>{msg.role === "user" ? "🧑 你: " : "🤖 AI: "}</Text>
                            {String(msg.content)}
                        </Text>
                    );
                })}

                {streamText && (
                    <Text color="white"><Text bold>🤖 AI: </Text>{streamText}</Text>
                )}
            </Box>

            {toolLogs.length > 0 && (
                <Box flexDirection="column" marginBottom={1} paddingLeft={2} borderLeftColor="yellow" borderStyle="single" borderTop={false} borderRight={false} borderBottom={false}>
                    {toolLogs.map((log, index) => (
                        <Text key={`log-${index}`} color="gray">{log}</Text>
                    ))}
                </Box>
            )}

            {isThinking ? (
                <Text color="yellow">⏳ 脑电波运转中...</Text>
            ) : (
                <Box>
                    <Text color="green" bold>✏️ 提问: </Text>
                    <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
                </Box>
            )}
        </Box>
    );
}