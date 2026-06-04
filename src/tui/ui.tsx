// src/tui/ui.tsx
import React, { useState, useEffect, useRef } from "react";
// 引入 useStdout 以动态获取终端高度，useInput 用于捕获 Tab/Escape 等特殊按键
import { Box, Text, Static, useStdout, useInput } from "ink";
import TextInput from "ink-text-input";

import type { Agent } from "../agent/agent.js";
import { useAgentLogic, type HistoryEntry } from "../agent/agentLogic.js";
import { formatTokenCount } from "../llm/tokens.js";
import { Markdown } from "./markdown.js";
import { ConfirmDialog } from "./confirm.js";
import { c } from "./colors.js"; // 引入你封装的模块
import { printSystemHeader } from "./header.js";
import { linkifyAll } from "./linkify.js";
import type { CommandRegistry } from "../slash/registry.js";
import type { SlashCommand } from "../slash/types.js";

// 💡 1. 定义动态历史记录的样式 (支持标题和内容的精细化控制)
const TYPE_STYLE: Record<HistoryEntry["type"], {
    title: { text: string; color: string; bold?: boolean };
    content: { color: string; dimColor?: boolean };
}> = {
    thinking: {
        title: { text: " [thinking] ", color: "gray", bold: true },
        content: { color: "gray", dimColor: true } // 内容变暗，区分层级
    },
    tool_call: {
        title: { text: " [tool calling] ", color: "green", bold: true },
        content: { color: "green" }
    },
    tool_result: {
        title: { text: " [tool result] ", color: "gray", bold: true },
        content: { color: "gray" }
    },
    answer: {
        title: { text: " [answer] ", color: "white", bold: true },
        content: { color: "white" }
    },
    user: {
        title: { text: " [user] ", color: "blue", bold: true },
        content: { color: "white" } // 标题绿色加粗，用户输入的内容用白色
    },
    system: {
        title: { text: " [system] ", color: "gray", bold: true },
        content: { color: "gray" }
    },
};

// 💡 2. 定义静态 UI 交互元素的样式
const UI_STYLE = {
    inputPrompt: { color: "green", prefix: "> " },
    agentRunning: { color: "yellow", text: " [agent running] " },
    statsLabel: { color: "gray" },
    statsInput: { color: "cyan" },
    statsOutput: { color: "magenta" },
    statsSpeed: { color: "yellow" }
};

interface AgentUIProps {
    agent: Agent;
    commandRegistry: CommandRegistry;
}

export function AgentUI({ agent, commandRegistry }: AgentUIProps) {
    // 获取标准输出对象，用于读取终端行数
    const { stdout } = useStdout();
    
    const {
        isThinking,
        isAnswering,
        thoughtStream,
        answerStream,
        history,
        conversationId,
        tokenStats,
        submitQuery,
        pendingConfirm,
        resolveConfirm,
        resetConversation,
    } = useAgentLogic(agent);

    const [input, setInput] = useState("");
    const [staticItems, setStaticItems] = useState<HistoryEntry[]>([]);
    const processedHistoryIds = useRef<Set<number>>(new Set());

    // ── 斜杠命令模式状态 ──
    const [isCommandMode, setIsCommandMode] = useState(false);
    const [commandSuggestions, setCommandSuggestions] = useState<SlashCommand[]>([]);
    const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

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

    // ── 输入变更：检测斜杠命令模式 ──
    const handleChange = (value: string) => {
        setInput(value);
        if (value.startsWith("/")) {
            setIsCommandMode(true);
            const prefix = value.slice(1).toLowerCase();
            const matches = commandRegistry.search(prefix);
            setCommandSuggestions(matches);
            setSelectedSuggestionIndex(0);
        } else {
            setIsCommandMode(false);
            setCommandSuggestions([]);
        }
    };

    // ── 命令提交 ──
    const handleSubmit = () => {
        if (isThinking || isAnswering || !input.trim()) return;

        const text = input.trim();

        // 斜杠命令路由
        if (text.startsWith("/")) {
            const parts = text.slice(1).split(/\s+/);
            const cmdName = parts[0] ?? "";
            const cmdArgs = parts.slice(1).join(" ");

            // 只输入了 "/" 没有命令名：显示可用命令列表
            if (!cmdName) {
                const all = commandRegistry.getAll();
                const list = all.map(c => `  /${c.name} — ${c.description}`).join("\n");
                setStaticItems(prev => [...prev, {
                    id: Date.now(),
                    type: "system" as const,
                    content: `可用命令:\n${list}`,
                    conversationId: conversationId,
                }]);
                setInput("");
                setIsCommandMode(false);
                setCommandSuggestions([]);
                return;
            }

            commandRegistry.execute(cmdName, {
                args: cmdArgs,
                ui: {
                    clearHistory: () => {
                        setStaticItems([]);
                        processedHistoryIds.current.clear();
                        // 清空终端屏幕上已有的 Static 渲染内容，重新绘制 Logo
                        process.stdout.write("\x1b[2J\x1b[H");
                        printSystemHeader(agent.registry.size, commandRegistry.size);
                    },
                    addSystemMessage: (msg: string) => {
                        setStaticItems(prev => [...prev, {
                            id: Date.now(),
                            type: "system" as const,
                            content: msg,
                            conversationId: conversationId,
                        }]);
                    },
                    newConversation: () => {
                        resetConversation();
                    },
                },
            }).then(result => {
                if (result.type === "error" && result.message) {
                    setStaticItems(prev => [...prev, {
                        id: Date.now(),
                        type: "system" as const,
                        content: result.message ?? "",
                        conversationId: conversationId,
                    }]);
                } else if (result.type === "output" && result.text) {
                    setStaticItems(prev => [...prev, {
                        id: Date.now(),
                        type: "system" as const,
                        content: result.text,
                        conversationId: conversationId,
                    }]);
                }
                // "success" 类型静默处理（命令自身已经完成 UI 操作）
            });

            setInput("");
            setIsCommandMode(false);
            setCommandSuggestions([]);
            return;
        }

        // 普通消息：提交给 Agent
        setInput("");
        submitQuery(text);
    };

    // ── Tab / Escape 按键拦截（ink-text-input 不处理这些键） ──
    useInput((_input, key) => {
        if (!isCommandMode) return;

        if (key.tab) {
            if (commandSuggestions.length === 1) {
                // 唯一匹配：直接补全
                const cmd = commandSuggestions[0]!;
                setInput("/" + cmd.name + " ");
                setCommandSuggestions([]);
                setIsCommandMode(false);
            } else if (commandSuggestions.length > 1) {
                // 多个匹配：循环选中
                setSelectedSuggestionIndex(
                    (selectedSuggestionIndex + 1) % commandSuggestions.length,
                );
            }
        }

        if (key.escape) {
            setIsCommandMode(false);
            setCommandSuggestions([]);
            setInput("");
        }
    });

    // ── 动态视口裁切逻辑 (Viewport Tail-Snapping) ──
    // 预留大约 10 行的安全边距（留给输入框、思考区、外边距及 Ink 内部缓冲区）
    const terminalHeight = stdout?.rows || 24;
    const safeHeight = Math.max(10, terminalHeight - 10);

    let displayStream = answerStream;
    if (isAnswering && answerStream) {
        const lines = answerStream.split('\n');
        // 如果输出行数超过了安全高度，则进行头部截断
        if (lines.length > safeHeight) {
            displayStream = c.dim("... (输出过长，已折叠。流式结束后将完全展示)") + "\n" + 
                lines.slice(-(safeHeight - 1)).join('\n');
        }
    }

    return (
        <Box flexDirection="column">
            {/* ── 1. 静态渲染区（安全封印区，用于存放已经完成的记录） ── */}
            <Static items={staticItems}>
                {(entry: HistoryEntry) => {
                    const style = TYPE_STYLE[entry.type] || TYPE_STYLE.answer;

                    // user 类型：前缀与内容同行显示
                    if (entry.type === "user") {
                        return (
                            <Box key={entry.id} marginTop={1} flexDirection="row">
                                <Text>
                                    <Text color={style.title.color} bold={style.title.bold ?? false}>
                                        {style.title.text}
                                    </Text>
                                    <Text color={style.content.color} dimColor={style.content.dimColor ?? false}>
                                        {linkifyAll(entry.content)}
                                    </Text>
                                </Text>
                            </Box>
                        );
                    }
                    
                    // answer 类型：使用 Markdown 独立成块渲染
                    if (entry.type === "answer") {
                        return (
                            <Box key={entry.id} flexDirection="column" marginTop={1}>
                                {style.title.text && (
                                    <Text color={style.title.color} bold={style.title.bold ?? false}>
                                        {style.title.text}
                                    </Text>
                                )}
                                <Markdown content={entry.content} />
                            </Box>
                        );
                    }
                    
                    // 其他类型 (thinking, tool_call 等)：前缀与内容同行显示
                    return (
                        <Box key={entry.id} flexDirection="row">
                            <Text>
                                {style.title.text && (
                                    <Text color={style.title.color} bold={style.title.bold ?? false}>
                                        {style.title.text}
                                    </Text>
                                )}
                                <Text color={style.content.color} dimColor={style.content.dimColor ?? false}>
                                    {linkifyAll(entry.content)}
                                </Text>
                            </Text>
                        </Box>
                    );
                }}
            </Static>

            {/* ── 2. 动态思考区 (仅在有思考流时出现，锁定 3 行高度防止跳动) ── */}
            {isThinking && thoughtStream && (
                <Box marginTop={1} flexDirection="column" height={3} overflow="hidden">
                    <Text>
                        {TYPE_STYLE.thinking.title.text && (
                            <Text color={TYPE_STYLE.thinking.title.color} bold={TYPE_STYLE.thinking.title.bold ?? false}>
                                {TYPE_STYLE.thinking.title.text}
                            </Text>
                        )}
                        <Text color={TYPE_STYLE.thinking.content.color} dimColor={TYPE_STYLE.thinking.content.dimColor ?? false}>
                            {linkifyAll(thoughtStream.split('\n').slice(-3).join('\n'))}
                        </Text>
                    </Text>
                </Box>
            )}

            {/* ── 3. 动态回答区 (渲染裁切后的 displayStream 以防高度溢出) ── */}
            {isAnswering && displayStream && (
                <Box marginTop={1} flexDirection="column">
                    {TYPE_STYLE.answer.title.text && (
                        <Text color={TYPE_STYLE.answer.title.color} bold={TYPE_STYLE.answer.title.bold ?? false}>
                            {TYPE_STYLE.answer.title.text}
                        </Text>
                    )}
                    <Markdown content={displayStream} />
                </Box>
            )}

            {/* ── 3.5. 斜杠命令建议面板 ── */}
            {isCommandMode && commandSuggestions.length > 0 && (
                <Box flexDirection="column" marginTop={0}>
                    {commandSuggestions.map((cmd, i) => (
                        <Text key={cmd.name} color={i === selectedSuggestionIndex ? "cyan" : "gray"}>
                            {i === selectedSuggestionIndex ? "› " : "  "}
                            /{cmd.name} — {cmd.description}
                        </Text>
                    ))}
                </Box>
            )}

            {/* ── 4. 交互指令区 (永远在最下方，防跳动) ── */}
            {pendingConfirm ? (
                <ConfirmDialog
                    pending={pendingConfirm}
                    onConfirm={resolveConfirm}
                />
            ) : (
                <Box
                    flexDirection="row"
                    marginTop={1}
                    alignItems="center"
                >
                    {(isThinking || isAnswering) ? (
                        <Text color={UI_STYLE.agentRunning.color}>
                            {UI_STYLE.agentRunning.text}
                        </Text>
                    ) : (
                        <>
                            <Text color={UI_STYLE.inputPrompt.color} bold>
                                {UI_STYLE.inputPrompt.prefix}
                            </Text>
                            <Box flexGrow={1} marginLeft={1}>
                                <TextInput
                                    value={input}
                                    onChange={handleChange}
                                    onSubmit={handleSubmit}
                                />
                            </Box>
                        </>
                    )}
                </Box>
            )}

            {/* ── 5. Token 统计栏 ── */}
            <Box flexDirection="row" marginTop={0}>
                <Text color={UI_STYLE.statsLabel.color}>
                    {"本轮 ↑"}
                    <Text color={UI_STYLE.statsInput.color}>{formatTokenCount(tokenStats.turnInputTokens)}</Text>
                    {" ↓"}
                    <Text color={UI_STYLE.statsOutput.color}>{formatTokenCount(tokenStats.turnOutputTokens)}</Text>
                    {" | 总计 ↑"}
                    <Text color={UI_STYLE.statsInput.color}>{formatTokenCount(tokenStats.sessionInputTokens)}</Text>
                    {" ↓"}
                    <Text color={UI_STYLE.statsOutput.color}>{formatTokenCount(tokenStats.sessionOutputTokens)}</Text>
                    {" | "}
                    {tokenStats.tokensPerSecond > 0 && (
                        <Text color={UI_STYLE.statsSpeed.color}>{tokenStats.tokensPerSecond} t/s</Text>
                    )}
                    {(tokenStats.cacheHitTokens > 0 || tokenStats.cacheMissTokens > 0) && (
                        <> {"| 命中:"}
                            <Text color={UI_STYLE.statsSpeed.color}>{formatTokenCount(tokenStats.cacheHitTokens)}</Text>
                            {" 未命中:"}
                            <Text color={UI_STYLE.statsLabel.color}>{formatTokenCount(tokenStats.cacheMissTokens)}</Text>
                        </>
                    )}
                </Text>
            </Box>
        </Box>
    );
}