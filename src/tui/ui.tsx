// src/tui/ui.tsx
import { useState, useEffect, useRef } from "react";
// 引入 useStdout 以动态获取终端高度
import { Box, Text, Static, useStdout } from "ink";
import TextInput from "ink-text-input";

import type { Agent } from "../agent/agent.js";
import { useAgentLogic, type HistoryEntry } from "../agent/agentLogic.js";
import { Markdown } from "./markdown.js";

const TYPE_STYLE: Record<HistoryEntry["type"], { color: string; prefix: string }> = {
    thinking: { color: "gray", prefix: "" },
    tool_call: { color: "green", prefix: "🔧 " },
    tool_result: { color: "gray", prefix: "  ✅ " },
    answer: { color: "white", prefix: "" },
    user: { color: "green", prefix: "🧑 你: " },
    system: { color: "gray", prefix: "" },
};

interface AgentUIProps {
    agent: Agent;
}

export function AgentUI({ agent }: AgentUIProps) {
    // 获取标准输出对象，用于读取终端行数
    const { stdout } = useStdout();
    
    const { 
        isThinking, 
        isAnswering, 
        thoughtStream, 
        answerStream, 
        history, 
        conversationId, 
        submitQuery 
    } = useAgentLogic(agent);

    const [input, setInput] = useState("");
    const [staticItems, setStaticItems] = useState<HistoryEntry[]>([]);
    const processedHistoryIds = useRef<Set<number>>(new Set());

    useEffect(() => {
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

    const handleSubmit = () => {
        // 防止在思考或流式输出阶段重复提交
        if (isThinking || isAnswering || !input.trim()) return;

        const queryToSubmit = input.trim();
        setInput("");
        submitQuery(queryToSubmit);
    };

    // ── 动态视口裁切逻辑 (Viewport Tail-Snapping) ──
    // 预留大约 10 行的安全边距（留给输入框、思考区、外边距及 Ink 内部缓冲区）
    const terminalHeight = stdout?.rows || 24;
    const safeHeight = Math.max(10, terminalHeight - 10);

    let displayStream = answerStream;
    if (isAnswering && answerStream) {
        const lines = answerStream.split('\n');
        // 如果输出行数超过了安全高度，则进行头部截断
        if (lines.length > safeHeight) {
            displayStream = "\x1b[2m... (输出过长，已折叠。流式结束后将完全展示)\x1b[0m\n" + 
                            lines.slice(-(safeHeight - 1)).join('\n');
        }
    }

    return (
        <Box flexDirection="column">
            {/* ── 1. 静态渲染区（安全封印区，用于存放已经完成的记录） ── */}
            <Static items={staticItems}>
                {(entry: HistoryEntry) => {
                    if (entry.type === "user") {
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

            {/* ── 2. 动态思考区 (仅在有思考流时出现，锁定 3 行高度防止跳动) ── */}
            {isThinking && thoughtStream && (
                <Box marginTop={1} flexDirection="column" height={3} overflow="hidden">
                    <Text color="gray">
                        {thoughtStream.split('\n').slice(-3).join('\n')}
                    </Text>
                </Box>
            )}

            {/* ── 3. 动态回答区 (渲染裁切后的 displayStream 以防高度溢出) ── */}
            {isAnswering && displayStream && (
                <Box marginTop={1} flexDirection="column">
                    <Markdown content={displayStream} />
                </Box>
            )}

            {/* ── 4. 交互指令区 (永远在最下方，防跳动) ── */}
            <Box
                flexDirection="row"
                marginTop={1}
                alignItems="center"
            >
                {(isThinking || isAnswering) ? (
                    <Text color="yellow">⏳ Agent 运行中...</Text>
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
        </Box>
    );
}