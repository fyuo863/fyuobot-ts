// src/agent/agentLogic.ts
import { useState, useRef, useCallback, useEffect } from "react";
import type OpenAI from "openai";
import type { Agent } from "./agent.js";
import {
    AgentTaskInterruptedError,
    persistInterruptedAssistantMessage,
} from "./agent-task.js";
import { buildInitialMessages, buildAgentIdentity } from "./prompts.js";
import { HistoryManager } from "../memory/history-manager.js";
import type { EventLoop } from "./event-loop.js";
import { createTuiSubscriptions } from "./event-bridge.js";
import type { AgentEvent } from "./events.js";
import type { TokenStats } from "../llm/tokens.js";

// ── 历史记录类型 ──────────────────────────────────────────────

export interface HistoryEntry {
    id: number;
    type: "thinking" | "tool_call" | "tool_result" | "answer" | "user" | "system";
    content: string;
}

/** 等待用户确认的敏感操作快照 */
export interface PendingConfirm {
    /** 工具调用 ID */
    toolCallId: string;
    /** 工具名称 */
    toolName: string;
    /** 工具参数（已解析为对象） */
    toolArgs: Record<string, unknown>;
}

/** 用户对敏感操作的确认结果 */
export interface ConfirmResult {
    /** 是否批准执行 */
    approved: boolean;
    /** 用户自定义反馈：拒绝原因、替代命令、修改建议等（可选） */
    feedback?: string;
}

/**
 * 初始消息 —— 按缓存优化顺序排列（由稳定到易变）：
 *   1. Agent 身份（永不变 —— 缓存锚点）
 *   2. 用户偏好 USER.md（启动时自动读取）
 *   3. 系统设置 MEMORY.md（启动时自动读取）
 *   4. 核心系统提示词（工具描述与规则）
 * 后续用户消息会追加到此数组末尾。
 */
const DEFAULT_IDENTITY = buildAgentIdentity("fyuobot");

function createInitialMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return buildInitialMessages(DEFAULT_IDENTITY);
}

// ── Hook ──────────────────────────────────────────────────────

/**
 * useAgentLogic — React Hook，连接 Agent 事件系统与 TUI 状态。
 *
 * 架构：
 *   - 事件 → React 状态的映射由 createTuiSubscriptions() 处理
 *   - Agent 任务执行由 agent.runTask() 处理
 *   - Hook 管理 React 特定的关注点：确认对话框、消息历史、token 统计
 *
 * @param agent Agent 实例
 * @param bus   用于发出事件的 MessageQueue
 * @param loop  用于订阅事件的 EventLoop
 */
export function useAgentLogic(agent: Agent, loop: EventLoop) {
    const [messages, setMessages] = useState<
        OpenAI.Chat.ChatCompletionMessageParam[]
    >(() => createInitialMessages());
    const messagesRef = useRef<OpenAI.Chat.ChatCompletionMessageParam[]>(
        createInitialMessages(),
    );

    // 引擎整体是否处于活跃状态（包含等待网络、调用工具等）
    const [isThinking, setIsThinking] = useState(false);
    // 引擎是否正在流式输出最终给用户的回答（用于触发 UI 的自适应 Markdown 框）
    const [isAnswering, setIsAnswering] = useState(false);

    // 动态流内容拆分
    const [thoughtStream, setThoughtStream] = useState("");
    const [answerStream, setAnswerStream] = useState("");

    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const historyIdRef = useRef(0);

    const pushHistory = (type: HistoryEntry["type"], content: string) => {
        const id = ++historyIdRef.current;
        setHistory((prev) => [...prev, { id, type, content }]);
    };

    // ── Token 统计（由事件驱动更新） ──────────────────────
    const [tokenStats, setTokenStats] = useState<TokenStats>({
        turnInputTokens: 0,
        turnOutputTokens: 0,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
        tokensPerSecond: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
    });

    // Session 级别的 token 累加器（事件只提供轮次数据，这里累加会话数据）
    const sessionInputRef = useRef(0);
    const sessionOutputRef = useRef(0);

    // Token 统计更新包装器 —— 累加会话总数
    const updateTokenStats = useCallback((stats: TokenStats) => {
        sessionInputRef.current += stats.turnInputTokens;
        sessionOutputRef.current += stats.turnOutputTokens;
        setTokenStats({
            ...stats,
            sessionInputTokens: sessionInputRef.current,
            sessionOutputTokens: sessionOutputRef.current,
        });
    }, []);

    // ── 敏感操作确认 ──────────────────────────────────────
    const confirmResolverRef = useRef<
        (result: ConfirmResult) => void
    >(undefined);
    const [pendingConfirm, setPendingConfirm] =
        useState<PendingConfirm | null>(null);
    const pendingConfirmRef = useRef<PendingConfirm | null>(null);

    // ── 对话轮次追踪（用于自动记录 history.db） ──────────
    const turnQueryRef = useRef("");
    const turnResponseRef = useRef("");
    const abortControllerRef = useRef<AbortController | null>(null);
    const activeContextRef = useRef<
        OpenAI.Chat.ChatCompletionMessageParam[] | null
    >(null);
    const activeTurnIdRef = useRef<string | null>(null);
    const ignoredTurnIdsRef = useRef<Set<string>>(new Set());
    const handledInterruptedTurnIdsRef = useRef<Set<string>>(new Set());
    const latestAnswerStreamRef = useRef("");
    const turnCounterRef = useRef(0);
    const uiBusyRef = useRef(false);

    useEffect(() => {
        latestAnswerStreamRef.current = answerStream;
    }, [answerStream]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        uiBusyRef.current = isThinking || isAnswering;
    }, [isThinking, isAnswering]);

    useEffect(() => {
        pendingConfirmRef.current = pendingConfirm;
    }, [pendingConfirm]);

    /** 发起确认请求，返回 Promise 在用户选择后 resolve */
    const requestConfirm = useCallback(
        (
            toolCallId: string,
            toolName: string,
            toolArgs: Record<string, unknown>,
        ): Promise<ConfirmResult> =>
            new Promise((resolve) => {
                confirmResolverRef.current = resolve;
                setPendingConfirm({ toolCallId, toolName, toolArgs });
            }),
        [],
    );

    /** 用户做出选择后调用 */
    const resolveConfirm = useCallback((result: ConfirmResult) => {
        confirmResolverRef.current?.(result);
        confirmResolverRef.current = undefined;
        setPendingConfirm(null);
    }, []);

    const [conversationId, setConversationId] = useState(0);

    // ── 事件订阅（核心：连接事件系统到 React 状态） ──────

    const shouldIgnoreEvent = useCallback((event: AgentEvent): boolean => {
        const turnId = "turnId" in event ? event.turnId : undefined;
        return (
            typeof turnId === "string" &&
            ignoredTurnIdsRef.current.has(turnId)
        );
    }, []);

    const setActiveTurnId = useCallback((turnId: string | null): void => {
        activeTurnIdRef.current = turnId;
    }, []);

    useEffect(() => {
        const subs = createTuiSubscriptions(loop, {
            setThoughtStream,
            setAnswerStream,
            setIsAnswering,
            pushHistory,
            setTokenStats: updateTokenStats,
            setIsThinking,
            getStreamText: () => "", // 不再需要——由事件处理
            getLastFlushTime: () => 0, // 不再需要——由 agent-task 处理节流
            setLastFlushTime: () => {}, // 不再需要
            streamFlushMs: 50,
            shouldIgnoreEvent,
            setActiveTurnId,
        });

        return () => subs.unsubscribeAll();
    }, [loop, updateTokenStats, shouldIgnoreEvent, setActiveTurnId]);

    // ── 公开接口 ────────────────────────────────────────────

    const submitQuery = async (query: string) => {
        if (!query.trim()) return;

        // ── 轮次追踪：记录用户查询，清空上一轮数据 ──
        turnQueryRef.current = query.trim();
        turnResponseRef.current = "";

        // 重置会话 token 累加器
        sessionInputRef.current = 0;
        sessionOutputRef.current = 0;

        const contextMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...messagesRef.current,
            { role: "user", content: query },
        ];
        const abortController = new AbortController();
        const turnId = `tui_turn_${++turnCounterRef.current}_${Date.now()}`;
        abortControllerRef.current = abortController;
        activeContextRef.current = contextMessages;
        activeTurnIdRef.current = turnId;
        messagesRef.current = contextMessages;

        setMessages([...contextMessages]);
        setIsThinking(true);
        setIsAnswering(false);
        setThoughtStream("");
        setAnswerStream("");
        setConversationId((prev) => prev + 1);
        setHistory([]);
        pushHistory("user", query);

        try {
            // 使用事件驱动的 Agent.runTask()
            const finalResponse = await agent.runTask(query, {
                confirmFn: requestConfirm,
                context: contextMessages,
                signal: abortController.signal,
                turnId,
            });

            // 捕获最终响应文本
            if (finalResponse) {
                turnResponseRef.current = finalResponse;
                pushHistory("answer", finalResponse);
                setMessages([...contextMessages]);
            }
        } catch (error) {
            if (error instanceof AgentTaskInterruptedError) {
                if (handledInterruptedTurnIdsRef.current.has(turnId)) {
                    return;
                }

                const partial =
                    error.partialContent || latestAnswerStreamRef.current;
                if (partial.trim()) {
                    turnResponseRef.current = partial;
                    pushHistory(
                        "answer",
                        `${partial.trim()}\n\n[已被用户打断，可继续补充]`,
                    );
                }
                pushHistory(
                    "system",
                    "已打断当前回答。你可以直接输入补充内容，Agent 会基于已暂存的上下文继续。",
                );
                handledInterruptedTurnIdsRef.current.add(turnId);
                messagesRef.current = [...contextMessages];
                setMessages([...contextMessages]);
                return;
            }

            pushHistory(
                "tool_result",
                `❌ 错误: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        } finally {
            if (activeTurnIdRef.current === turnId) {
                activeTurnIdRef.current = null;
                setIsThinking(false);
                setIsAnswering(false);
                setThoughtStream("");
                setAnswerStream("");
            }
            if (abortControllerRef.current === abortController) {
                abortControllerRef.current = null;
            }
            if (activeContextRef.current === contextMessages) {
                activeContextRef.current = null;
            }
        }
    };

    const interruptCurrentTask = useCallback((): boolean => {
        const controller = abortControllerRef.current;
        const hasActiveUi =
            uiBusyRef.current || pendingConfirmRef.current !== null;
        if (!controller && !hasActiveUi) return false;

        const turnId = activeTurnIdRef.current;
        if (turnId) {
            ignoredTurnIdsRef.current.add(turnId);
        }

        const partial = latestAnswerStreamRef.current;
        const context = activeContextRef.current;
        const alreadyHandled =
            typeof turnId === "string" &&
            handledInterruptedTurnIdsRef.current.has(turnId);

        if (context && !alreadyHandled) {
            persistInterruptedAssistantMessage(context, partial);
            messagesRef.current = [...context];
            setMessages([...context]);
        }
        if (turnId && !alreadyHandled) {
            handledInterruptedTurnIdsRef.current.add(turnId);
        }
        if (partial.trim() && !alreadyHandled) {
            turnResponseRef.current = partial;
            pushHistory(
                "answer",
                `${partial.trim()}\n\n[已被用户打断，可继续补充]`,
            );
        }
        if (!alreadyHandled) {
            pushHistory(
                "system",
                "已打断当前回答。你可以直接输入补充内容，Agent 会基于已暂存的上下文继续。",
            );
        }

        confirmResolverRef.current?.({
            approved: false,
            feedback: "用户已打断当前任务。",
        });
        confirmResolverRef.current = undefined;
        pendingConfirmRef.current = null;
        setPendingConfirm(null);

        if (controller && !controller.signal.aborted) {
            controller.abort();
        }

        activeTurnIdRef.current = null;
        uiBusyRef.current = false;
        setIsThinking(false);
        setIsAnswering(false);
        setThoughtStream("");
        setAnswerStream("");
        return true;
    }, []);

    /** 重置对话上下文：清空消息历史、Token 统计、UI 状态 */
    const resetConversation = useCallback(() => {
        const initialMessages = createInitialMessages();
        messagesRef.current = initialMessages;
        setMessages(initialMessages);
        setHistory([]);
        historyIdRef.current = 0;
        setThoughtStream("");
        setAnswerStream("");
        setIsThinking(false);
        setIsAnswering(false);
        sessionInputRef.current = 0;
        sessionOutputRef.current = 0;
        setTokenStats({
            turnInputTokens: 0,
            turnOutputTokens: 0,
            sessionInputTokens: 0,
            sessionOutputTokens: 0,
            tokensPerSecond: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
        });
        // 新对话 ID，触发 UI 的 processedHistoryIds 清理
        setConversationId((prev) => prev + 1);
        // 开始新的 HistoryManager 会话
        HistoryManager.instance().startNewSession();
    }, []);

    return {
        messages,
        isThinking,
        isAnswering,
        thoughtStream,
        answerStream,
        history,
        conversationId,
        tokenStats,
        submitQuery,
        interruptCurrentTask,
        pendingConfirm,
        resolveConfirm,
        resetConversation,
    };
}
