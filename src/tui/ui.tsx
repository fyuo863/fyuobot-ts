// src/tui/ui.tsx
import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, Static } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";
import process from "process";

import type { ToolRegistry } from "../tools/basetool.js";
import { useAgentLogic } from "../agent/agentLogic.js";
import type { HistoryEntry } from "../agent/agentLogic.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { AgentStatus } from "../agent/agent.js";
import { router } from "../tools/router-tool.js";
import { Markdown } from "./markdown.js";
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
            return "  ✅ ";
        case "answer":
            return "";
        case "thinking":
            return "";
    }
}

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

// 定义联合类型，允许 Static 渲染特殊的 Header
type StaticItem = { type: "system_header"; id: string } | HistoryEntry;

export function AgentUI({ registry, tools, runtime }: AgentUIProps) {
    const {
        isThinking,
        streamText,
        history,
        conversationId,
        submitQuery,
    } = useAgentLogic(registry, tools);
    const [input, setInput] = useState("");
    const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);

    // 定时拉取后台 Agent 状态
    useEffect(() => {
        const tick = () => setAgentStatuses(runtime.getAllStatus());
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [runtime]);

    // Runtime 状态 → name 速查表
    const statusMap = useMemo(() => {
        const map = new Map<string, AgentStatus>();
        for (const s of agentStatuses) {
            map.set(s.name, s);
        }
        return map;
    }, [agentStatuses]);

    // 将 Logo 注入到历史记录的最前方
    const staticItems = useMemo<StaticItem[]>(() => {
        return [
            { type: "system_header", id: "app-logo-header" },
            ...history
        ];
    }, [history]);

    const handleSubmit = () => {
        submitQuery(input);
        setInput("");
    };

    return (
        // 移除根节点的 padding=1，防止纵向空间计算抖动导致跳屏
        <Box flexDirection="column">
            
            {/* ── 历史展示区与顶部 Header（Static）──
                现在 Header 已经被安全地封印在 Static 中，只渲染一次，完美避免闪烁和错位
            */}
            <Static key={conversationId} items={staticItems}>
                {(entry: StaticItem) => {
                    if (entry.type === "system_header") {
                        return (
                            <Box
                                key={entry.id}
                                borderStyle="round"
                                borderColor="cyan"
                                paddingX={2}
                                paddingY={0}
                                marginBottom={1}
                                flexDirection="column"
                                alignItems="flex-start"
                            >
                                <Box flexDirection="column" marginBottom={1} width={35} flexShrink={0}>
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
                                <Box flexDirection="column" justifyContent="center">
                                    <Text bold>📁 当前目录: {process.cwd()}</Text>
                                    <Text dimColor>💡 系统状态: 已加载 {registry.size} 个工具</Text>
                                </Box>
                            </Box>
                        );
                    }

                    // 常规历史记录渲染
                    if (entry.type === "answer") {
                        return (
                            <Box key={entry.id} flexDirection="column" marginTop={1}>
                                <Markdown content={entry.content} />
                            </Box>
                        );
                    }

                    // 其他类型（如 tool_call, tool_result 等）保持原样普通文本输出
                    return (
                        <Text key={entry.id} color={colorForType(entry.type)}>
                            {prefixForType(entry.type)}
                            {entry.content}
                        </Text>
                    );
                }}
            </Static>

            {/* ── 动态渲染区（极度轻量化，防止终端跳帧） ── */}
            {streamText && (
                <Box marginTop={1}>
                    <Markdown content={streamText} />
                </Box>
            )}
            {/* 底部输入 / 加载区域 */}
            {isThinking ? (
                <Box paddingX={1} marginTop={1}>
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
                    <Text color="green" bold>{">"}{" "}</Text>
                    <Box flexGrow={1} marginLeft={1}>
                        <TextInput
                            value={input}
                            onChange={setInput}
                            onSubmit={handleSubmit}
                        />
                    </Box>
                </Box>
            )}

            {/* Agent 状态栏 */}
            <Box paddingX={1} flexDirection="row" columnGap={3}>
                {router.registeredAgents.map((name) => {
                    const s = statusMap.get(name);
                    if (s) {
                        return (
                            <Text
                                key={name}
                                color={
                                    s.busy ? "yellow" : s.running ? "green" : "gray"
                                }
                            >
                                {statusIcon(s)} {name}
                                <Text dimColor> 待处理:{s.pendingTasks}</Text>
                                {s.busy && <Text color="yellow"> 工作中</Text>}
                            </Text>
                        );
                    }
                    return (
                        <Text key={name} color="gray">
                            ⏹ {name}
                            <Text dimColor> 待处理:{router.pendingCount(name)}</Text>
                        </Text>
                    );
                })}
                {router.registeredAgents.length === 0 && (
                    <Text dimColor>暂无已注册 Agent</Text>
                )}
            </Box>
        </Box>
    );
}