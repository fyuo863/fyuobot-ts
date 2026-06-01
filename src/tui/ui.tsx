// src/agent/AgentUI.tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";
import process from "process";

import type { ToolRegistry } from "../tools/basetool.js";
import { useAgentLogic } from "../agent/agentLogic.js"; 

interface AgentUIProps {
    registry: ToolRegistry;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
}

export function AgentUI({ registry, tools }: AgentUIProps) {
    const { messages, isThinking, streamText, toolLogs, submitQuery } = useAgentLogic(registry, tools);
    const [input, setInput] = useState("");
    
    const isHorizontal = false; //硬编码排版状态

    const handleSubmit = () => {
        submitQuery(input);
        setInput(""); 
    };

    return (
        <Box flexDirection="column" padding={1}>
            {/* 顶部 Header 区域：受硬编码变量 isHorizontal 控制 */}
            <Box 
                borderStyle="round" 
                borderColor="cyan" 
                paddingX={2} 
                paddingY={0} 
                flexDirection={isHorizontal ? "row" : "column"} 
                alignItems={isHorizontal ? "center" : "flex-start"}
            >
                {/* 左侧/顶部：fyuobot 盲文阴影 Logo */}
                <Box 
                    flexDirection="column" 
                    marginRight={isHorizontal ? 3 : 0} 
                    marginBottom={!isHorizontal ? 1 : 0} 
                    width={35} 
                    flexShrink={0}
                >
                    {[
                        "  ██ █  █ █  █  ██  █     ██   █  ",
                        " █   █  █ █  █ █  █ ███  █  █ ███ ",
                        " ███  ███ █  █ █  █ █  █ █  █  █  ",
                        " █      █  ██   ██  ███   ██   ██ ",
                        "" // 盲文阴影渲染空间
                    ].map((row, y, arr) => (
                        <Text key={y}>
                            {Array.from({ length: 35 }).map((_, x) => {
                                const isMain = row[x] === "█";
                                const isShadow = y > 0 && x > 0 && arr[y - 1]?.[x - 1] === "█";
                                
                                if (isMain) return <Text key={x} backgroundColor="white"> </Text>;
                                if (isShadow) return <Text key={x} color="gray">⣿</Text>;
                                return <Text key={x}> </Text>;
                            })}
                        </Text>
                    ))}
                </Box>

                {/* 右侧/底部：状态信息 */}
                <Box flexDirection="column" justifyContent="center">
                    <Text bold>📁 当前目录: {process.cwd()}</Text>
                    <Text dimColor>💡 系统状态: 已加载 {registry.size} 个工具 (文本占位)</Text>
                </Box>
            </Box>

            {/* 对话历史展示区 */}
            <Box flexDirection="column" marginBottom={1} paddingX={1}>
                {messages.map((msg, index) => {
                    if (msg.role === "system" || msg.role === "tool") return null;
                    if (msg.role === "assistant" && !msg.content) return null;

                    return (
                        <Text key={index} color={msg.role === "user" ? "green" : "white"}>
                            <Text bold>{msg.role === "user" ? "user: " : "fyuobot: "}</Text>
                            {String(msg.content)}
                        </Text>
                    );
                })}

                {streamText && (
                    <Text color="white"><Text bold>🤖 AI: </Text>{streamText}</Text>
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

            {/* 底部输入/加载区域 */}
            {isThinking ? (
                <Box paddingX={1}>
                    <Text color="yellow">⏳ 脑电波运转中...</Text>
                </Box>
            ) : (
                <Box 
                    flexDirection="row" 
                    borderStyle="single" 
                    borderColor="gray"
                    borderLeft={false} 
                    borderRight={false} 
                    paddingX={1}
                >
                    <Text color="green" bold>✏️ 提问: </Text>
                    <Box flexGrow={1} marginLeft={1}>
                        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
                    </Box>
                </Box>
            )}
        </Box>
    );
}