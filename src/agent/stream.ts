// src/agent/stream.ts
//
// 框架无关的 Agent 流式会话层。
// 基于事件驱动架构 —— 通过 EventLoop 订阅接收流事件，
// 通过 MessageQueue 发出任务请求。
//
// 每个 StreamingSession 维护自己的消息上下文和 token 统计。
// 可通过 EventLoop 上的事件订阅被任意消费者使用（TUI、HTTP SSE、WebSocket 等）。

import type OpenAI from "openai";
import type { Agent } from "./agent.js";
import type { MessageQueue } from "./message-queue.js";
import type { EventLoop } from "./event-loop.js";
import { AgentEventType as ET } from "./events.js";
import type { TokenStats } from "../llm/tokens.js";
import { buildInitialMessages, buildAgentIdentity } from "./prompts.js";
import { HistoryManager } from "../memory/history-manager.js";
import type { ToolCallRecord } from "../memory/history-manager.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 用户对敏感操作的确认结果 */
export interface ConfirmResult {
    approved: boolean;
    feedback?: string;
}

/**
 * 流式事件回调接口 —— 保留用于向后兼容。
 * 新代码应直接订阅 EventLoop 上的事件。
 *
 * @deprecated 使用 EventLoop.on() 直接订阅事件类型。
 */
export interface StreamHandler {
    /** 单个文本 token */
    onToken(token: string): void;
    /** <think> 块内容（DeepSeek 等模型的思考过程） */
    onThinking(text: string): void;
    /** 非 think 的流式回答文本 */
    onAnswer(text: string): void;
    /** LLM 请求调用工具 */
    onToolCall(name: string, args: string): void;
    /** 工具执行进度 */
    onToolProgress(name: string, progress: string): void;
    /** 工具执行结果摘要 */
    onToolResult(name: string, summary: string): void;
    /**
     * 敏感操作需要确认。
     * 返回 Promise —— 消费者负责获取用户决定后 resolve。
     */
    onConfirmRequired(
        toolCallId: string,
        toolName: string,
        toolArgs: Record<string, unknown>,
    ): Promise<ConfirmResult>;
    /** 查询完成 */
    onDone(usage: Record<string, unknown> | undefined, finalContent: string): void;
    /** 处理过程中发生错误 */
    onError(error: Error): void;
    /** Token 统计更新 */
    onTokenStats(stats: TokenStats): void;
}

// ── 初始消息（与 agentLogic.ts 共享同一构建逻辑） ──────────

const DEFAULT_IDENTITY = buildAgentIdentity("fyuobot");

function createInitialMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return buildInitialMessages(DEFAULT_IDENTITY);
}

// ── StreamingSession ─────────────────────────────────────────

/**
 * 独立的流式会话 —— 维护自己的消息历史、Token 统计，
 * 通过 EventLoop 上的事件订阅通知消费者。
 *
 * 每个会话拥有独立的消息上下文，互不干扰。
 *
 * @example
 * ```typescript
 * const session = new StreamingSession(agent, bus, loop);
 * // 订阅事件以获取流数据
 * loop.on(AgentEventType.STREAM_ANSWER, (e) => console.log(e.text));
 * // 提交查询（阻塞直到完成）
 * await session.submitQuery("帮我写一个函数");
 * ```
 */
export class StreamingSession {
    private agent: Agent;
    private bus: MessageQueue;
    private loop: EventLoop;
    private messages: OpenAI.Chat.ChatCompletionMessageParam[];
    private _busy = false;

    // 本轮追踪（用于自动记录 history.db）
    private turnQuery = "";
    private turnResponse = "";
    private turnTools: ToolCallRecord[] = [];

    constructor(agent: Agent, bus: MessageQueue, loop: EventLoop) {
        this.agent = agent;
        this.bus = bus;
        this.loop = loop;
        this.messages = createInitialMessages();
    }

    // ── 状态 ──────────────────────────────────────────────

    get isBusy(): boolean {
        return this._busy;
    }

    getStatus() {
        return this.agent.status;
    }

    // ── 查询入口 ──────────────────────────────────────────

    /**
     * 提交查询，运行完整 LLM 工具调用循环。阻塞直到完成或出错。
     *
     * 流事件（token、thinking、answer、tool progress 等）
     * 通过 EventLoop 发出——消费者应在调用此方法前订阅。
     *
     * @param query      用户查询文本
     * @param confirmFn  敏感操作确认回调（可选，不提供则自动批准）
     */
    async submitQuery(
        query: string,
        confirmFn?: (
            toolCallId: string,
            toolName: string,
            args: Record<string, unknown>,
        ) => Promise<ConfirmResult>,
        options: {
            turnId?: string;
            signal?: AbortSignal;
        } = {},
    ): Promise<void> {
        if (!query.trim()) return;
        if (this._busy) {
            throw new Error("Agent 正忙，请等待当前任务完成");
        }

        this._busy = true;
        this.turnQuery = query.trim();
        this.turnResponse = "";
        this.turnTools = [];

        // 追加用户消息到上下文
        this.messages.push({ role: "user", content: query });

        try {
            // 使用 Agent 的上下文（包含用户消息）运行任务
            // 注意：agent.runTask() 使用自己的 buildContext()，
            // 但我们需要使用 StreamingSession 的消息上下文。
            // 这里直接通过 agent 的注册中心运行任务，
            // 使用 StreamingSession 的消息数组作为上下文。
            const { runAgentTask } = await import("./agent-task.js");

            const turnId = options.turnId ?? `stream_${Date.now()}`;
            const result = await runAgentTask({
                registry: this.agent.registry,
                bus: this.bus,
                context: this.messages, // 使用 StreamingSession 的上下文
                turnId,
                confirmFn: confirmFn ?? (async () => ({ approved: true })),
                ...(options.signal ? { signal: options.signal } : {}),
            });

            this.turnResponse = result.finalContent;
            this.turnTools = result.toolCallRecords;
        } catch (error) {
            const err =
                error instanceof Error ? error : new Error(String(error));
            // 错误事件由 runAgentTask 内部发出
            throw err;
        } finally {
            this._busy = false;

            // 被动全量记录对话到 history.db
            if (this.turnQuery && this.turnResponse) {
                try {
                    HistoryManager.instance().saveTurn(
                        "",
                        this.turnQuery,
                        this.turnResponse,
                        this.turnTools.length > 0 ? this.turnTools : undefined,
                    );
                } catch (e) {
                    console.warn(
                        "[history] 记录失败:",
                        e instanceof Error ? e.message : String(e),
                    );
                }
            }

        }
    }

    /**
     * 创建一个向后兼容的 StreamHandler，将事件从 EventLoop
     * 桥接到旧的 StreamHandler 回调模式。
     *
     * @param handler 旧的 StreamHandler 回调
     * @returns 取消订阅的函数
     */
    createHandlerBridge(handler: StreamHandler): () => void {
        const unsubs: Array<() => void> = [];

        unsubs.push(
            this.loop.on(ET.LLM_TOKEN, (event) => {
                handler.onToken(event.token);
            }),
        );
        unsubs.push(
            this.loop.on(ET.STREAM_THINKING, (event) => {
                handler.onThinking(event.text);
            }),
        );
        unsubs.push(
            this.loop.on(ET.STREAM_ANSWER, (event) => {
                handler.onAnswer(event.text);
            }),
        );
        unsubs.push(
            this.loop.on(ET.TOOL_PROGRESS, (event) => {
                handler.onToolProgress(event.toolName, event.progress);
            }),
        );
        unsubs.push(
            this.loop.on(ET.TOOL_EXECUTION_COMPLETE, (event) => {
                handler.onToolResult(
                    event.toolName,
                    event.hideOutput
                        ? `[${event.toolName}] 输出已隐藏（由工具配置控制）`
                        : event.summary,
                );
            }),
        );
        unsubs.push(
            this.loop.on(ET.TOKEN_STATS_UPDATE, (event) => {
                handler.onTokenStats(event.stats);
            }),
        );

        return () => unsubs.forEach((fn) => fn());
    }

    /** 重置对话上下文 */
    reset(): void {
        this.messages = createInitialMessages();
        HistoryManager.instance().startNewSession();
    }
}
