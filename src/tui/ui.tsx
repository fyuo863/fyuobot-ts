// src/tui/ui.tsx
import React, { useState, useEffect, useMemo, useRef } from "react";
import { Box, Text, Static } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";
import process from "process";
import crypto from "crypto";

import type { ToolRegistry } from "../tools/basetool.js";
import { useAgentLogic, type HistoryEntry } from "../agent/agentLogic.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { AgentStatus } from "../agent/agent.js";
import { router } from "../tools/router-tool.js";
import { Markdown } from "./markdown.js";

// ── 1. 类型定义与样式配置 ──────────────────────────────────────────────

const TYPE_STYLE: Record<HistoryEntry["type"], { color: string; prefix: string }> = {
    tool_call: { color: "green", prefix: "🔧 " },
    tool_result: { color: "gray", prefix: "  ✅ " },
    answer: { color: "white", prefix: "" },
    thinking: { color: "gray", prefix: "" }
};

type LogItem =
    | { type: "system_header"; id: string }
    | { type: "user_input"; id: string; content: string }
    | HistoryEntry;

interface AgentUIProps {
    registry: ToolRegistry;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    runtime: AgentRuntime;
}

// ── 2. 纯视图子组件 ───────────────────────────────────────────────────

const SystemHeader = ({ toolCount }: { toolCount: number }) => {
    const LOGO_LINES = [
        "  ██ █  █ █  █  ██  █    ██   █  ",
        "  █   █  █ █  █ █  █ ███  █  █ ███ ",
        "  ███  ███ █  █ █  █ █  █ █  █  █  ",
        "  █      █  ██   ██  ███   ██   ██ ",
        ""
    ];

    return (
        <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1} flexDirection="column" alignItems="flex-start">
            <Box flexDirection="column" marginBottom={1} flexShrink={0}>
                {LOGO_LINES.map((row, y, arr) => (
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
            <Box flexDirection="column">
                <Text bold>📁 当前目录: {process.cwd()}</Text>
                <Text dimColor>💡 系统状态: 已加载 {toolCount} 个工具</Text>
            </Box>
        </Box>
    );
};

const StatusBar = ({ statusMap }: { statusMap: Map<string, AgentStatus> }) => (
    <Box paddingX={1} flexDirection="row" columnGap={3}>
        {router.registeredAgents.map((name) => {
            const s = statusMap.get(name);
            if (s) {
                return (
                    <Text key={name} color={s.busy ? "yellow" : s.running ? "green" : "gray"}>
                        {s.running ? (s.busy ? "🔄" : "🟢") : "⏹"} {name}
                        <Text dimColor> 待处理:{s.pendingTasks}</Text>
                        {s.busy && <Text color="yellow"> 工作中</Text>}
                    </Text>
                );
            }
            return (
                <Text key={name} color="gray">
                    ⏹ {name} <Text dimColor> 待处理:{router.pendingCount(name)}</Text>
                </Text>
            );
        })}
        {router.registeredAgents.length === 0 && <Text dimColor>暂无已注册 Agent</Text>}
    </Box>
);

// ── 3. 主逻辑组件 ─────────────────────────────────────────────────────

export function AgentUI({ registry, tools, runtime }: AgentUIProps) {
    const { isThinking, streamText, history, conversationId, submitQuery } = useAgentLogic(registry, tools);
    
    const [input, setInput] = useState("");
    const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);
    
    // 静态历史账本，负责将所有动态操作“固化”到终端输出中
    const [staticItems, setStaticItems] = useState<LogItem[]>([]);
    const processedHistoryIds = useRef<Set<string>>(new Set());

    // 生命周期：新对话初始化 Header
    useEffect(() => {
        setStaticItems([{ type: "system_header", id: `header_${conversationId}` }]);
        processedHistoryIds.current.clear();
    }, [conversationId]);

    // 生命周期：接管并固化历史记录
    useEffect(() => {
        if (history.length === 0) return;
        const newItems = history.filter(h => !processedHistoryIds.current.has(h.id));
        if (newItems.length > 0) {
            newItems.forEach(h => processedHistoryIds.current.add(h.id));
            setStaticItems(prev => [...prev, ...newItems]);
        }
    }, [history]);

    // 生命周期：轮询 Agent 工作状态
    useEffect(() => {
        const tick = () => setAgentStatuses(runtime.getAllStatus());
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [runtime]);

    const statusMap = useMemo(() => {
        const map = new Map<string, AgentStatus>();
        agentStatuses.forEach(s => map.set(s.name, s));
        return map;
    }, [agentStatuses]);

    // 安全的提交函数：拦截空请求和并发碰撞
    const handleSubmit = () => {
        if (isThinking || !input.trim()) return;
        
        // 1. 生成安全唯一 ID
        const userItem: LogItem = { 
            type: "user_input", 
            id: crypto.randomUUID(), 
            content: input.trim() 
        };
        
        // 2. 先推入历史，再清空输入框，最后发送请求，确保视觉反馈极致顺滑
        setStaticItems(prev => [...prev, userItem]);
        const queryToSubmit = input.trim();
        setInput("");
        submitQuery(queryToSubmit);
    };

    return (
        <Box flexDirection="column">
            {/* ── 静态渲染区（安全封印区） ── */}
            <Static items={staticItems}>
                {(entry: LogItem) => {
                    if (entry.type === "system_header") {
                        return <SystemHeader key={entry.id} toolCount={registry.size} />;
                    }
                    if (entry.type === "user_input") {
                        return (
                            <Box key={entry.id} marginTop={1} flexDirection="row">
                                <Text color="green" bold>🧑 你: </Text>
                                <Text>{entry.content}</Text>
                            </Box>
                        );
                    }
                    if (entry.type === "answer") {
                        return (
                            <Box key={entry.id} flexDirection="column" marginTop={1}>
                                <Markdown content={entry.content} />
                            </Box>
                        );
                    }
                    const style = TYPE_STYLE[entry.type] || TYPE_STYLE.answer;
                    return (
                        <Text key={entry.id} color={style.color}>
                            {style.prefix}{entry.content}
                        </Text>
                    );
                }}
            </Static>

            {/* ── 动态渲染区（流式打字机） ── */}
            {streamText && (
                <Box marginTop={1} flexDirection="column" height={3} overflow="hidden">
                    <Text color="gray">{streamText.split('\n').slice(-3).join('\n')}</Text>
                </Box>
            )}

            {/* ── 交互指令区（高度绝对锁定） ── */}
            <Box
                flexDirection="row"
                borderStyle="single"
                borderColor={isThinking ? "yellow" : "gray"}
                borderLeft={false}
                borderRight={false}
                paddingX={1}
                marginTop={1}
                height={3} // 锁定高度，杜绝框体伸缩跳动
                alignItems="center"
            >
                {isThinking ? (
                    <Text color="yellow">⏳ 脑电波运转中... 目标 Agent 正在执行任务，请稍候</Text>
                ) : (
                    <>
                        <Text color="green" bold>{">"} </Text>
                        <Box flexGrow={1} marginLeft={1}>
                            <TextInput
                                value={input}
                                onChange={setInput}
                                onSubmit={handleSubmit}
                            />
                        </Box>
                    </>
                )}
            </Box>

            {/* ── Agent 监控栏 ── */}
            <StatusBar statusMap={statusMap} />
        </Box>
    );
}