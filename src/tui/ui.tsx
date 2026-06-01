// src/tui/ui.tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";
import process from "process";

import type { ToolRegistry } from "../tools/basetool.js";
import { useAgentLogic } from "../agent/agentLogic.js";
import type { HistoryEntry } from "../agent/agentLogic.js";

// ── 渲染辅助 ──────────────────────────────────────────────────

/** 按条目类型返回 Ink Text 颜色 */
function colorForType(type: HistoryEntry["type"]): string {
    switch (type) {
        case "tool_call":
            return "green";
        case "tool_result":
            return "gray";
        case "answer":
            return "white";
        case "thinking":
            return "gray";
    }
}

/** 按条目类型返回前缀图标 */
function prefixForType(type: HistoryEntry["type"]): string {
    switch (type) {
        case "tool_call":
            return "🔧 ";
        case "tool_result":
            return "   ✅ ";
        case "answer":
            return "";
        case "thinking":
            return "";
    }
}

// ── 组件 ──────────────────────────────────────────────────────

interface AgentUIProps {
    registry: ToolRegistry;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
}

export function AgentUI({ registry, tools }: AgentUIProps) {
    const { isThinking, streamText, history, submitQuery } = useAgentLogic(registry, tools);
    const [input, setInput] = useState("");

    const isHorizontal = false; // 硬编码排版状态

    const handleSubmit = () => {
        submitQuery(input);
        setInput("");
    };

    return (
        <Box flexDirection="column" padding={1}>
            {/* 顶部 Header 区域 */}
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
                        "",
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
                    <Text dimColor>💡 系统状态: 已加载 {registry.size} 个工具</Text>
                </Box>
            </Box>

            {/* ── 统一历史展示区 ──
                每条 history 记录按其自身类型分配颜色，不折叠、不隐藏。
                thinking  / tool_result → gray
                tool_call               → green
                answer                  → white
                流式文本在历史末尾以灰色追加显示 */}
            <Box flexDirection="column" marginBottom={1} paddingX={1}>
                {history.map((entry) => (
                    <Text key={entry.id} color={colorForType(entry.type)}>
                        {prefixForType(entry.type)}
                        {entry.content}
                    </Text>
                ))}

                {/* 流式思考过程：灰色字体实时打印 */}
                {streamText && (
                    <Text color="gray">{streamText}</Text>
                )}
            </Box>

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
