// src/tui/ui.tsx
import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, Static } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";

import type { ToolRegistry } from "../tools/basetool.js";
import { useAgentLogic } from "../agent/agentLogic.js";
import type { HistoryEntry } from "../agent/agentLogic.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { AgentStatus } from "../agent/agent.js";
import { router } from "../tools/router-tool.js";
import { Markdown } from "./markdown.js";

const TYPE_STYLE: Record<HistoryEntry["type"], { color: string; prefix: string }> = {
    tool_call: { color: "green", prefix: "🔧 " },
    tool_result: { color: "gray", prefix: "  ✅ " },
    answer: { color: "white", prefix: "" },
    thinking: { color: "gray", prefix: "" }
};

const getStatusTheme = (s: AgentStatus) => ({
    icon: s.busy ? "🔄" : s.running ? "🟢" : "⏹",
    color: s.busy ? "yellow" : s.running ? "green" : "gray"
});

const AgentStatusBar = ({ statusMap }: { statusMap: Map<string, AgentStatus> }) => (
    <Box paddingX={1} flexDirection="row" columnGap={3}>
        {router.registeredAgents.length === 0 ? (
            <Text dimColor>暂无已注册 Agent</Text>
        ) : (
            router.registeredAgents.map((name) => {
                const s = statusMap.get(name);
                if (!s) {
                    return (
                        <Text key={name} color="gray">
                            ⏹ {name} <Text dimColor>待处理:{router.pendingCount(name)}</Text>
                        </Text>
                    );
                }
                const theme = getStatusTheme(s);
                return (
                    <Text key={name} color={theme.color}>
                        {theme.icon} {name}
                        <Text dimColor> 待处理:{s.pendingTasks}</Text>
                        {s.busy && <Text color="yellow"> 工作中</Text>}
                    </Text>
                );
            })
        )}
    </Box>
);

interface AgentUIProps {
    registry: ToolRegistry;
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    runtime: AgentRuntime;
}

export function AgentUI({ registry, tools, runtime }: AgentUIProps) {
    const { isThinking, streamText, history, conversationId, submitQuery } = useAgentLogic(registry, tools);
    const [input, setInput] = useState("");
    const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);

    useEffect(() => {
        const tick = () => setAgentStatuses(runtime.getAllStatus());
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [runtime]);

    const statusMap = useMemo(() => new Map(agentStatuses.map(s => [s.name, s])), [agentStatuses]);

    return (
        <Box flexDirection="column">
            {/* 纯粹的历史日志区域 */}
            <Static key={conversationId} items={history}>
                {(entry: HistoryEntry) => {
                    if (entry.type === "answer") return <Box key={entry.id} flexDirection="column" marginTop={1}><Markdown content={entry.content} /></Box>;
                    
                    const style = TYPE_STYLE[entry.type] || TYPE_STYLE.answer;
                    return (
                        <Text key={entry.id} color={style.color}>
                            {style.prefix}{entry.content}
                        </Text>
                    );
                }}
            </Static>

            {/* 流式文本截断防爆屏渲染 */}
            {streamText && (
                <Box marginTop={1} flexDirection="column">
                    <Text color="gray">{streamText.split('\n').slice(-15).join('\n')}</Text>
                </Box>
            )}

            {/* 底部交互区 */}
            {isThinking ? (
                <Box paddingX={1} marginTop={1}><Text color="yellow">⏳ 脑电波运转中...</Text></Box>
            ) : (
                <Box flexDirection="row" borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false} paddingX={1}>
                    <Text color="green" bold>{">"} </Text>
                    <Box flexGrow={1} marginLeft={1}>
                        <TextInput 
                            value={input} 
                            onChange={setInput} 
                            onSubmit={() => { submitQuery(input); setInput(""); }} 
                        />
                    </Box>
                </Box>
            )}

            {/* Agent 状态监控栏 */}
            <AgentStatusBar statusMap={statusMap} />
        </Box>
    );
}