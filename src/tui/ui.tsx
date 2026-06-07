// src/tui/ui.tsx
import React, { useState, useEffect, useRef } from "react";
// 引入 useStdout 以动态获取终端高度，useInput 用于捕获 Tab/Escape 等特殊按键
import { Box, Text, Static, useStdout, useInput } from "ink";
import TextInput from "ink-text-input";

import type { Agent } from "../agent/agent.js";
import type { EventLoop } from "../agent/event-loop.js";
import { useAgentLogic, type HistoryEntry } from "../agent/agentLogic.js";
import { formatTokenCount } from "../llm/tokens.js";
import { Markdown } from "./markdown.js";
import { ConfirmDialog } from "./confirm.js";
import { printSystemHeader } from "./header.js";
import { linkifyAll } from "./linkify.js";
import type { CommandRegistry } from "../slash/registry.js";
import type { SlashCommand } from "../slash/types.js";

// 1. 先定义样式对象的类型
interface StyleConfig {
    title: { text: string; color: string; bold?: boolean };
    content: { color: string; dimColor?: boolean };
}

// 2. 将 answer 作为兜底默认样式，单独拿出来（类型 100% 安全）
const DEFAULT_STYLE: StyleConfig = {
    title: { text: " [answer] ", color: "white", bold: true },
    content: { color: "white" },
};

// 3. 定义字典，并将 answer 指向默认样式
const TYPE_STYLE: Record<string, StyleConfig> = {
    thinking: {
        title: { text: " [thinking] ", color: "gray", bold: true },
        content: { color: "gray", dimColor: true },
    },
    tool_call: {
        title: { text: " [tool calling] ", color: "green", bold: true },
        content: { color: "green" },
    },
    tool_result: {
        title: { text: " [tool result] ", color: "gray", bold: true },
        content: { color: "gray" },
    },
    answer: DEFAULT_STYLE, // 这里直接复用
    user: {
        title: { text: " [user] ", color: "blue", bold: true },
        content: { color: "white" },
    },
    system: {
        title: { text: " [system] ", color: "gray", bold: true },
        content: { color: "gray" },
    },
};

// 💡 2. 定义静态 UI 交互元素的样式
const UI_STYLE = {
    inputPrompt: { color: "green", prefix: "> " },
    agentRunning: { color: "yellow", text: " [agent running] " },
    statsLabel: { color: "gray" },
    statsInput: { color: "cyan" },
    statsOutput: { color: "magenta" },
    statsSpeed: { color: "yellow" },
};

interface AgentUIProps {
    agent: Agent;
    commandRegistry: CommandRegistry;
    loop: EventLoop;
}

export function AgentUI({ agent, commandRegistry, loop }: AgentUIProps) {
    const { stdout } = useStdout();

    const {
        isThinking,
        isAnswering,
        answerStream,
        history,
        conversationId,
        tokenStats,
        submitQuery,
        pendingConfirm,
        resolveConfirm,
        resetConversation,
    } = useAgentLogic(agent, loop);

    const [input, setInput] = useState("");
    const [staticItems, setStaticItems] = useState<any[]>([]);

    // 修复：为了防止内存泄漏，只记录最后处理过的 ID
    const lastProcessedHistoryId = useRef<number>(-1);

    // ── 计时器状态 ──
    const [thinkSeconds, setThinkSeconds] = useState(0);

    // ── 斜杠命令模式状态 ──
    const [isCommandMode, setIsCommandMode] = useState(false);
    const [commandSuggestions, setCommandSuggestions] = useState<SlashCommand[]>(
        [],
    );
    const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

    // Refs
    const isCommandModeRef = useRef(isCommandMode);
    const commandSuggestionsRef = useRef(commandSuggestions);
    const selectedSuggestionIndexRef = useRef(selectedSuggestionIndex);

    const prevIsThinkingRef = useRef(isThinking);
    const thinkSecondsRef = useRef(thinkSeconds);
    const currentTokensRef = useRef(tokenStats.turnOutputTokens);

    // 同步 Ref
    useEffect(() => {
        isCommandModeRef.current = isCommandMode;
        commandSuggestionsRef.current = commandSuggestions;
        selectedSuggestionIndexRef.current = selectedSuggestionIndex;
    }, [isCommandMode, commandSuggestions, selectedSuggestionIndex]);

    // 同步计时与 Token 状态到 Ref，供闭包读取
    useEffect(() => {
        thinkSecondsRef.current = thinkSeconds;
        currentTokensRef.current = tokenStats.turnOutputTokens;
    }, [thinkSeconds, tokenStats.turnOutputTokens]);

    // 重置会话时清理历史记录游标
    useEffect(() => {
        lastProcessedHistoryId.current = -1;
    }, [conversationId]);

    // ── 计时器逻辑 ──
    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;
        if (isThinking) {
            setThinkSeconds(0);
            interval = setInterval(() => {
                setThinkSeconds((s) => s + 1);
            }, 1000);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isThinking]);

    // ── 核心魔法：拦截思考结束的瞬间，注入永久静态记录 ──
    useEffect(() => {
        if (prevIsThinkingRef.current === true && isThinking === false) {
            // 构造一条独一无二的静态计时汇总记录
            const summaryEntry = {
                id: Date.now() + Math.random(),
                type: "thinking_summary",
                content: `${thinkSecondsRef.current}s ${formatTokenCount(currentTokensRef.current)} tokens`,
                conversationId: conversationId,
            };
            setStaticItems((prev) => [...prev, summaryEntry]);
        }
        prevIsThinkingRef.current = isThinking;
    }, [isThinking, conversationId]);

    // ── 生命周期：接管并固化历史记录 ──
    useEffect(() => {
        if (history.length === 0) return;

        // 获取所有原始的最新记录
        const rawNewItems = history.filter(
            (h) => h.id > lastProcessedHistoryId.current,
        );

        if (rawNewItems.length > 0) {
            const lastItem = rawNewItems[rawNewItems.length - 1];
            if (lastItem) {
                lastProcessedHistoryId.current = lastItem.id;
            }

            // 💡 关键：屏蔽原生的 thinking 日志，因为它会被我们自定义的 thinking_summary 完美替代
            const displayItems = rawNewItems.filter(
                (h) => h.type !== "thinking",
            );
            if (displayItems.length > 0) {
                setStaticItems((prev) => [...prev, ...displayItems]);
            }
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
            resetCommandMode();
        }
    };

    const resetCommandMode = () => {
        setIsCommandMode(false);
        setCommandSuggestions([]);
        setSelectedSuggestionIndex(0);
    };

    const handleCommandExecute = async (text: string) => {
        const parts = text.slice(1).split(/\s+/);
        const cmdName = parts[0] ?? "";
        const cmdArgs = parts.slice(1).join(" ");

        if (!cmdName) {
            const all = commandRegistry.getAll();
            const list = all
                .map((c) => `  /${c.name} — ${c.description}`)
                .join("\n");
            setStaticItems((prev) => [
                ...prev,
                {
                    id: Date.now(),
                    type: "system",
                    content: `可用命令:\n${list}`,
                    conversationId: conversationId,
                },
            ]);
            setInput("");
            resetCommandMode();
            return;
        }

        const result = await commandRegistry.execute(cmdName, {
            args: cmdArgs,
            ui: {
                clearHistory: () => {
                    setStaticItems([]);
                    lastProcessedHistoryId.current = -1;
                    process.stdout.write("\x1b[2J\x1b[H");
                    printSystemHeader(
                        agent.registry.size,
                        commandRegistry.size,
                    );
                },
                addSystemMessage: (msg: string) => {
                    setStaticItems((prev) => [
                        ...prev,
                        {
                            id: Date.now(),
                            type: "system",
                            content: msg,
                            conversationId: conversationId,
                        },
                    ]);
                },
                newConversation: () => {
                    resetConversation();
                },
            },
        });

        if (result.type === "error" && result.message) {
            setStaticItems((prev) => [
                ...prev,
                {
                    id: Date.now(),
                    type: "system",
                    content: result.message ?? "",
                    conversationId: conversationId,
                },
            ]);
        } else if (result.type === "output" && result.text) {
            setStaticItems((prev) => [
                ...prev,
                {
                    id: Date.now(),
                    type: "system",
                    content: result.text,
                    conversationId: conversationId,
                },
            ]);
        }

        setInput("");
        resetCommandMode();
    };

    const handleSubmit = () => {
        if (isThinking || isAnswering || !input.trim()) return;

        const text = input.trim();

        if (text.startsWith("/")) {
            handleCommandExecute(text);
            return;
        }

        setInput("");
        submitQuery(text);
    };

    useInput((_input, key) => {
        if (
            !isCommandModeRef.current ||
            commandSuggestionsRef.current.length === 0
        )
            return;

        const suggestions = commandSuggestionsRef.current;
        const currentIndex = selectedSuggestionIndexRef.current;

        if (key.upArrow && suggestions.length > 0) {
            setSelectedSuggestionIndex(
                (currentIndex - 1 + suggestions.length) % suggestions.length,
            );
            return;
        }
        if (key.downArrow && suggestions.length > 0) {
            setSelectedSuggestionIndex(
                (currentIndex + 1) % suggestions.length,
            );
            return;
        }

        if (key.tab) {
            const cmd = suggestions[currentIndex];
            if (cmd) {
                setInput("/" + cmd.name + " ");
                resetCommandMode();
            }
            return;
        }

        if (key.escape) {
            resetCommandMode();
            setInput("");
        }
    });

    return (
        <Box flexDirection="column">
            {/* ── 1. 静态渲染区 ── */}
            <Static items={staticItems}>
                {(entry: any) => {
                    // 专门处理我们注入的 thinking_summary 类型
                    if (entry.type === "thinking_summary") {
                        return (
                            <Box key={entry.id} marginTop={1}>
                                <Text color="gray" bold>
                                    {` [思考完毕 ${entry.content}] `}
                                </Text>
                            </Box>
                        );
                    }

                    const style = TYPE_STYLE[entry.type] || DEFAULT_STYLE;

                    if (entry.type === "user") {
                        return (
                            <Box
                                key={entry.id}
                                marginTop={1}
                                flexDirection="row"
                            >
                                <Text>
                                    <Text
                                        color={style.title.color}
                                        bold={style.title.bold ?? false}
                                    >
                                        {style.title.text}
                                    </Text>
                                    <Text
                                        color={style.content.color}
                                        dimColor={
                                            style.content.dimColor ?? false
                                        }
                                    >
                                        {linkifyAll(entry.content)}
                                    </Text>
                                </Text>
                            </Box>
                        );
                    }

                    if (entry.type === "answer") {
                        return (
                            <Box
                                key={entry.id}
                                flexDirection="column"
                                marginTop={1}
                            >
                                {style.title.text && (
                                    <Text
                                        color={style.title.color}
                                        bold={style.title.bold ?? false}
                                    >
                                        {style.title.text}
                                    </Text>
                                )}
                                <Markdown content={entry.content} />
                            </Box>
                        );
                    }

                    return (
                        <Box key={entry.id} flexDirection="row">
                            <Text>
                                {style.title.text && (
                                    <Text
                                        color={style.title.color}
                                        bold={style.title.bold ?? false}
                                    >
                                        {style.title.text}
                                    </Text>
                                )}
                                <Text
                                    color={style.content.color}
                                    dimColor={
                                        style.content.dimColor ?? false
                                    }
                                >
                                    {linkifyAll(entry.content)}
                                </Text>
                            </Text>
                        </Box>
                    );
                }}
            </Static>

            {/* ── 2. 动态计时思考区 (思考时展示) ── */}
            {isThinking && (
                <Box marginTop={1}>
                    <Text color="gray" bold>
                        {` [思考中... ${thinkSeconds}s ${formatTokenCount(tokenStats.turnOutputTokens)} tokens] `}
                    </Text>
                </Box>
            )}

            {/* ── 3. 自然流式回答区 (解除一切高度限制) ── */}
            {isAnswering && answerStream && (
                <Box marginTop={1} flexDirection="column">
                    {DEFAULT_STYLE.title.text && (
                        <Text
                            color={DEFAULT_STYLE.title.color}
                            bold={DEFAULT_STYLE.title.bold ?? false}
                        >
                            {DEFAULT_STYLE.title.text}
                        </Text>
                    )}
                    <Markdown content={answerStream} />
                </Box>
            )}

            {/* ── 3.5 动态斜杠命令提示区 (支持无限命令滚动) ── */}
            <Box height={3} flexDirection="column">
                {isCommandMode && commandSuggestions.length > 0 ? (
                    <Box flexDirection="column" paddingX={1}>
                        {(() => {
                            const MAX_LINES = 3;

                            let startIdx = selectedSuggestionIndex - 1;
                            if (startIdx < 0) startIdx = 0;
                            if (
                                startIdx + MAX_LINES >
                                commandSuggestions.length
                            ) {
                                startIdx = Math.max(
                                    0,
                                    commandSuggestions.length - MAX_LINES,
                                );
                            }

                            const visibleCommands = commandSuggestions.slice(
                                startIdx,
                                startIdx + MAX_LINES,
                            );

                            return visibleCommands.map((cmd) => {
                                const isSelected =
                                    cmd.name ===
                                    commandSuggestions[
                                        selectedSuggestionIndex
                                    ]?.name;

                                return (
                                    <Text key={cmd.name}>
                                        <Text
                                            color={
                                                isSelected
                                                    ? "cyan"
                                                    : "gray"
                                            }
                                            bold={isSelected}
                                        >
                                            {isSelected
                                                ? "› "
                                                : "  "}
                                            /{cmd.name}
                                        </Text>
                                        <Text color="gray">
                                            {" — "}
                                            {cmd.description}
                                        </Text>
                                    </Text>
                                );
                            });
                        })()}
                    </Box>
                ) : (
                    <Box></Box>
                )}
            </Box>

            {/* ── 4. 交互指令区 ── */}
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
                    {isThinking || isAnswering ? (
                        <Text color={UI_STYLE.agentRunning.color}>
                            {UI_STYLE.agentRunning.text}
                        </Text>
                    ) : (
                        <>
                            <Text
                                color={UI_STYLE.inputPrompt.color}
                                bold
                            >
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
                    <Text color={UI_STYLE.statsInput.color}>
                        {formatTokenCount(tokenStats.turnInputTokens)}
                    </Text>
                    {" ↓"}
                    <Text color={UI_STYLE.statsOutput.color}>
                        {formatTokenCount(tokenStats.turnOutputTokens)}
                    </Text>
                    {" | 总计 ↑"}
                    <Text color={UI_STYLE.statsInput.color}>
                        {formatTokenCount(tokenStats.sessionInputTokens)}
                    </Text>
                    {" ↓"}
                    <Text color={UI_STYLE.statsOutput.color}>
                        {formatTokenCount(tokenStats.sessionOutputTokens)}
                    </Text>
                    {" | "}
                    {tokenStats.tokensPerSecond > 0 && (
                        <Text color={UI_STYLE.statsSpeed.color}>
                            {tokenStats.tokensPerSecond} t/s
                        </Text>
                    )}
                    {(tokenStats.cacheHitTokens > 0 ||
                        tokenStats.cacheMissTokens > 0) && (
                        <>
                            {" "}
                            {"| 命中:"}
                            <Text color={UI_STYLE.statsSpeed.color}>
                                {formatTokenCount(
                                    tokenStats.cacheHitTokens,
                                )}
                            </Text>
                            {" 未命中:"}
                            <Text color={UI_STYLE.statsLabel.color}>
                                {formatTokenCount(
                                    tokenStats.cacheMissTokens,
                                )}
                            </Text>
                        </>
                    )}
                </Text>
            </Box>
        </Box>
    );
}
