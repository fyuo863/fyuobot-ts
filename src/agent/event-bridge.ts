// src/agent/event-bridge.ts
//
// TUI 事件订阅桥接 —— 提取 useAgentLogic 中的样板代码，
// 设置从事件循环到 React 状态更新的标准事件订阅。
//
// 这使 hook 保持简洁：hook 调用 createTuiSubscriptions 一次，
// 获取一组标准化的订阅，并在卸载时取消。

import { AgentEventType } from "./events.js";
import type { EventLoop } from "./event-loop.js";
import type { TokenStats } from "../llm/tokens.js";
import type { HistoryEntry } from "./agentLogic.js";

// ── 类型 ──────────────────────────────────────────────────────

/**
 * createTuiSubscriptions 所需的 React 状态 setter 集合。
 * 这些与 useAgentLogic 中的 useState setter 一一对应。
 */
export interface TuiStateSetters {
    /** 设置思考流文本（<think> 标签内容） */
    setThoughtStream: (text: string) => void;
    /** 设置回答流文本 */
    setAnswerStream: (text: string) => void;
    /** 设置 isAnswering 标志 */
    setIsAnswering: (answering: boolean) => void;
    /** 推送一条历史记录 */
    pushHistory: (type: HistoryEntry["type"], content: string) => void;
    /** 更新 token 统计显示 */
    setTokenStats: (stats: TokenStats) => void;
    /** 设置 isThinking 标志 */
    setIsThinking: (thinking: boolean) => void;
    /** 获取当前流文本缓冲区的 ref（用于节流后的最终同步） */
    getStreamText: () => string;
    /** 获取上次刷新时间 ref（用于节流控制） */
    getLastFlushTime: () => number;
    /** 设置上次刷新时间 */
    setLastFlushTime: (time: number) => void;
    /** 节流间隔 (ms) */
    streamFlushMs: number;
}

/**
 * createTuiSubscriptions 的返回值。
 * 包含用于卸载所有订阅的统一取消函数。
 */
export interface TuiSubscriptions {
    /** 取消所有已注册的事件订阅 */
    unsubscribeAll: () => void;
}

// ── 创建订阅 ──────────────────────────────────────────────────

/**
 * 在 EventLoop 上创建标准的 TUI 事件订阅集合。
 *
 * 将事件类型映射到 React 状态更新：
 *   LLM_TOKEN         → 累积流文本，按节流间隔更新 answerStream/thoughtStream
 *   TOOL_PROGRESS     → 更新 thoughtStream 以显示工具进度
 *   TOOL_EXECUTION_COMPLETE → 将 tool_result 推入 history
 *   STREAM_THINKING   → 更新 thoughtStream
 *   STREAM_ANSWER     → 更新 answerStream，设置 isAnswering
 *   TASK_START        → 设置 isThinking = true
 *   TASK_COMPLETE     → 设置 isThinking = false
 *   TASK_ERROR        → 设置 isThinking = false，将错误推入 history
 *   TOKEN_STATS_UPDATE → 更新 tokenStats
 *
 * 节流：
 *   LLM_TOKEN 事件可能高频触发（20+ 事件/秒）。为了不压垮 React 渲染，
 *   STREAM_THINKING/STREAM_ANSWER 事件的发出在 agent-task.ts 中基于
 *   STREAM_FLUSH_MS 间隔（50ms）进行节流。
 *
 * @param loop         用于注册的事件循环
 * @param stateSetters React 状态 setter 和 ref getter
 * @returns 带有 unsubscribeAll 方法的订阅句柄
 */
export function createTuiSubscriptions(
    loop: EventLoop,
    stateSetters: TuiStateSetters,
): TuiSubscriptions {
    const unsubs: Array<() => void> = [];

    // ── LLM Token → 不直接更新 UI（使用节流的流事件） ──
    // LLM_TOKEN 事件由 agent-task.ts 发出，同时节流的流事件
    // 也被发出。这里的订阅主要用于调试/日志记录。

    // ── 工具进度 → 更新 thoughtStream ──
    unsubs.push(
        loop.on(AgentEventType.TOOL_PROGRESS, (event) => {
            stateSetters.setThoughtStream(
                `🔧 ${event.toolName}: ${event.progress}`,
            );
        }),
    );

    // ── 工具执行完成 → 推送 tool_result 到历史记录 ──
    unsubs.push(
        loop.on(AgentEventType.TOOL_EXECUTION_COMPLETE, (event) => {
            stateSetters.pushHistory("tool_result", event.summary);
        }),
    );

    // ── 流思考 → 更新 thoughtStream ──
    unsubs.push(
        loop.on(AgentEventType.STREAM_THINKING, (event) => {
            stateSetters.setThoughtStream(event.text);
        }),
    );

    // ── 流回答 → 更新 answerStream + isAnswering ──
    unsubs.push(
        loop.on(AgentEventType.STREAM_ANSWER, (event) => {
            stateSetters.setAnswerStream(event.text);
            stateSetters.setIsAnswering(true);
        }),
    );

    // ── 任务开始 → 设置 isThinking ──
    unsubs.push(
        loop.on(AgentEventType.TASK_START, (_event) => {
            stateSetters.setIsThinking(true);
            stateSetters.setIsAnswering(false);
            stateSetters.setThoughtStream("");
            stateSetters.setAnswerStream("");
        }),
    );

    // ── 任务完成 → 清除所有活跃状态 ──
    unsubs.push(
        loop.on(AgentEventType.TASK_COMPLETE, (_event) => {
            stateSetters.setThoughtStream("");
            stateSetters.setAnswerStream("");
            stateSetters.setIsAnswering(false);
            stateSetters.setIsThinking(false);
        }),
    );

    // ── 任务错误 → 推送错误并清除所有活跃状态 ──
    unsubs.push(
        loop.on(AgentEventType.TASK_ERROR, (event) => {
            stateSetters.pushHistory(
                "tool_result",
                `❌ 错误: ${event.error}`,
            );
            stateSetters.setThoughtStream("");
            stateSetters.setAnswerStream("");
            stateSetters.setIsAnswering(false);
            stateSetters.setIsThinking(false);
        }),
    );

    // ── Token 统计更新 → 更新 tokenStats 状态 ──
    unsubs.push(
        loop.on(AgentEventType.TOKEN_STATS_UPDATE, (event) => {
            stateSetters.setTokenStats(event.stats);
        }),
    );

    return {
        unsubscribeAll: () => {
            for (const unsub of unsubs) {
                unsub();
            }
            unsubs.length = 0;
        },
    };
}
