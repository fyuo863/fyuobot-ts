// src/tui/ui.tsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";
import process from "process";

import type { ToolRegistry } from "../tools/basetool.js";
import { useAgentLogic } from "../agent/agentLogic.js";
import type { HistoryEntry } from "../agent/agentLogic.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { AgentStatus } from "../agent/agent.js";

// ── 渲染辅助 ──────────────────────────────────────────────────

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

/** Agent 状态对应的图标 */
function statusIcon(s: AgentStatus): string {
    if (!s.running) return "⏹";
    if (s.busy) return "🔄";
    return "🟢";
}

// ── 组件 ──────────────────────────────────────────────────────

interface AgentUIProps {
    registry: ToolRegistry;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    runtime: AgentRuntime;
}

export function AgentUI({ registry, tools, runtime }: AgentUIProps) {
    const { isThinking, streamText, history, submitQuery } = useAgentLogic(registry, tools);
    const [input, setInput] = useState("");
    const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);

    // 定时拉取后台 Agent 状态
    useEffect(() => {
        const tick = () => setAgentStatuses(runtime.getAllStatus());
        tick(); // 首帧立即获取
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [runtime]);

    const isHorizontal = false;

    const handleSubmit = () => {
        submitQuery(input);
        setInput("");
    };

    return (
        <Box flexDirection="column" padding={1}>
            {/* 顶部 Header */}
            <Box
                borderStyle="round"
                borderColor="cyan"
                paddingX={2}
                paddingY={0}
                flexDirection={isHorizontal ? "row" : "column"}
                alignItems={isHorizontal ? "center" : "flex-start"}
            >
                {/* Logo */}
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
                                const isShadow =
                                    y > 0 && x > 0 && arr[y - 1]?.[x - 1] === "█";

                                if (isMain)
                                    return (
                                        <Text key={x} backgroundColor="white">
                                            {" "}
                                        </Text>
                                    );
                                if (isShadow)
                                    return (
                                        <Text key={x} color="gray">
                                            ⣿
                                        </Text>
                                    );
                                return <Text key={x}> </Text>;
                            })}
                        </Text>
                    ))}
                </Box>

                {/* 状态信息 */}
                <Box flexDirection="column" justifyContent="center">
                    <Text bold>📁 当前目录: {process.cwd()}</Text>
                    <Text dimColor>
                        💡 系统状态: 已加载 {registry.size} 个工具
                    </Text>
                </Box>
            </Box>

            {/* ── Agent 状态栏 ── */}
            <Box
                borderStyle="single"
                borderColor="blue"
                paddingX={1}
                flexDirection="row"
                columnGap={3}
            >
                {agentStatuses.map((s) => (
                    <Text key={s.name} color={s.busy ? "yellow" : s.running ? "green" : "gray"}>
                        {statusIcon(s)} {s.name}
                        <Text dimColor> 待处理:{s.pendingTasks}</Text>
                        {s.busy && <Text color="yellow"> 工作中</Text>}
                        {"  "}
                    </Text>
                ))}
                {agentStatuses.length === 0 && (
                    <Text dimColor>无后台 Agent 运行</Text>
                )}
            </Box>

            {/* ── 统一历史展示区 ── */}
            <Box flexDirection="column" marginBottom={1} paddingX={1}>
                {history.map((entry) => (
                    <Text key={entry.id} color={colorForType(entry.type)}>
                        {prefixForType(entry.type)}
                        {entry.content}
                    </Text>
                ))}

                {/* 流式思考过程：灰色字体实时打印 */}
                {streamText && <Text color="gray">{streamText}</Text>}
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
                    <Text color="green" bold>
                        ✏️ 提问:{" "}
                    </Text>
                    <Box flexGrow={1} marginLeft={1}>
                        <TextInput
                            value={input}
                            onChange={setInput}
                            onSubmit={handleSubmit}
                        />
                    </Box>
                </Box>
            )}
        </Box>
    );
}
