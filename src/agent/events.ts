// src/agent/events.ts
//
// 类型化事件定义 —— 事件驱动架构的单一事实来源。
// 系统中的所有通信都通过此文件中定义的事件进行。
//
// 每个事件都有一个 `type` 判别字段和一个 `turnId` 关联标识符，
// 用于将同一轮对话中的所有事件关联在一起。

import type { TokenStats } from "../llm/tokens.js";

// ── 事件类型枚举 ──────────────────────────────────────────────

export enum AgentEventType {
    // ── Agent 生命周期 ──
    /** Agent 已初始化，准备就绪 */
    AGENT_INIT = "agent:init",
    /** Agent 已准备就绪，可以接收查询 */
    AGENT_READY = "agent:ready",
    /** Agent 正在关闭 */
    AGENT_SHUTDOWN = "agent:shutdown",

    // ── 用户输入 ──
    /** 用户提交了查询 */
    USER_QUERY = "user:query",
    /** 敏感操作需要用户确认 */
    USER_CONFIRM_REQUEST = "user:confirm_request",
    /** 用户对敏感操作确认做出了响应 */
    USER_CONFIRM_RESPONSE = "user:confirm_response",
    /** 用户取消了当前操作 */
    USER_CANCEL = "user:cancel",

    // ── LLM 交互 ──
    /** LLM 请求已开始 */
    LLM_REQUEST_START = "llm:request_start",
    /** 收到单个文本 token（高频事件） */
    LLM_TOKEN = "llm:token",
    /** LLM 响应中包含了工具调用 */
    LLM_TOOL_CALLS_RECEIVED = "llm:tool_calls_received",
    /** LLM 响应已完成（含完整内容和 usage） */
    LLM_RESPONSE_COMPLETE = "llm:response_complete",
    /** LLM 调用出错 */
    LLM_ERROR = "llm:error",

    // ── 工具执行 ──
    /** 工具开始执行 */
    TOOL_EXECUTION_START = "tool:execution_start",
    /** 工具执行进度更新 */
    TOOL_PROGRESS = "tool:progress",
    /** 工具执行完成 */
    TOOL_EXECUTION_COMPLETE = "tool:execution_complete",
    /** 工具执行出错 */
    TOOL_ERROR = "tool:error",

    // ── 任务协调 ──
    /** 任务开始（一次用户查询 = 一个任务） */
    TASK_START = "task:start",
    /** 任务步骤（一次 LLM 工具调用循环迭代） */
    TASK_STEP = "task:step",
    /** 任务完成 */
    TASK_COMPLETE = "task:complete",
    /** 任务出错 */
    TASK_ERROR = "task:error",

    // ── 流式输出（UI 专用） ──
    /** <think> 块内容（DeepSeek 等模型的思考过程） */
    STREAM_THINKING = "stream:thinking",
    /** 非 think 的流式回答文本 */
    STREAM_ANSWER = "stream:answer",

    // ── Token 统计 ──
    /** Token 统计已更新 */
    TOKEN_STATS_UPDATE = "token:stats_update",

    // ── 持久化 ──
    /** 对话已保存到 history.db */
    HISTORY_SAVE = "history:save",

    // ── A2A / 子 Agent 通信 ──
    /** 子 Agent 已启动 */
    SUB_AGENT_START = "sub_agent:start",
    /** 子 Agent 进度更新 */
    SUB_AGENT_PROGRESS = "sub_agent:progress",
    /** 子 Agent 任务完成 */
    SUB_AGENT_COMPLETE = "sub_agent:complete",
    /** 子 Agent 任务失败 */
    SUB_AGENT_ERROR = "sub_agent:error",
    /** 子 Agent 结果已推送，等待主 Agent 消费 */
    SUB_AGENT_RESULT_READY = "sub_agent:result_ready",
}

// ── 事件负载接口 ──────────────────────────────────────────────

// ── 生命周期 ──

export interface AgentInitEvent {
    type: AgentEventType.AGENT_INIT;
    agentName: string;
}

export interface AgentReadyEvent {
    type: AgentEventType.AGENT_READY;
    agentName: string;
}

export interface AgentShutdownEvent {
    type: AgentEventType.AGENT_SHUTDOWN;
    agentName: string;
}

// ── 用户输入 ──

export interface UserQueryEvent {
    type: AgentEventType.USER_QUERY;
    /** 本轮对话的唯一关联 ID */
    turnId: string;
    /** 用户输入的原始查询文本 */
    query: string;
    /** 查询提交的时间戳 (ms) */
    timestamp: number;
}

export interface UserConfirmRequestEvent {
    type: AgentEventType.USER_CONFIRM_REQUEST;
    turnId: string;
    /** 关联的工具调用 ID */
    toolCallId: string;
    /** 工具名称 */
    toolName: string;
    /** 工具参数 */
    args: Record<string, unknown>;
    /** 请求确认的时间戳 (ms) */
    timestamp: number;
}

export interface UserConfirmResponseEvent {
    type: AgentEventType.USER_CONFIRM_RESPONSE;
    turnId: string;
    /** 关联的工具调用 ID */
    toolCallId: string;
    /** 工具名称 */
    toolName: string;
    /** 是否批准 */
    approved: boolean;
    /** 用户反馈（可选） */
    feedback?: string;
}

export interface UserCancelEvent {
    type: AgentEventType.USER_CANCEL;
    turnId: string;
    /** 取消原因（可选） */
    reason?: string;
}

// ── LLM 交互 ──

export interface LlmRequestStartEvent {
    type: AgentEventType.LLM_REQUEST_START;
    turnId: string;
    /** 此时上下文中的消息数量 */
    contextSize: number;
    /** 这是第几次 LLM 调用（从 1 开始） */
    llmCallIndex: number;
}

export interface LlmTokenEvent {
    type: AgentEventType.LLM_TOKEN;
    turnId: string;
    /** 单个文本 token */
    token: string;
    /** 累积的响应文本 */
    cumulativeText: string;
}

export interface LlmToolCallsReceivedEvent {
    type: AgentEventType.LLM_TOOL_CALLS_RECEIVED;
    turnId: string;
    /** 本次响应中的所有工具调用 */
    toolCalls: Array<{
        /** 工具调用的唯一 ID */
        id: string;
        /** 工具名称 */
        name: string;
        /** JSON 字符串形式的参数 */
        arguments: string;
        /** 已解析的参数对象 */
        parsedArgs: Record<string, unknown>;
    }>;
}

export interface LlmResponseCompleteEvent {
    type: AgentEventType.LLM_RESPONSE_COMPLETE;
    turnId: string;
    /** 完整的响应内容 */
    content: string;
    /** 从 <think> 标签中解析出的思考内容 */
    thinkingContent: string;
    /** API 返回的原始 usage 数据 */
    usage: Record<string, unknown> | undefined;
}

export interface LlmErrorEvent {
    type: AgentEventType.LLM_ERROR;
    turnId: string;
    /** 错误信息 */
    error: string;
    /** 错误发生的 LLM 调用索引 */
    llmCallIndex: number;
}

// ── 工具执行 ──

export interface ToolExecutionStartEvent {
    type: AgentEventType.TOOL_EXECUTION_START;
    turnId: string;
    /** 关联的工具调用 ID（与 LLM 的 tool_call.id 对应） */
    toolCallId: string;
    /** 工具名称 */
    toolName: string;
    /** 工具参数 */
    args: Record<string, unknown>;
    /** 在本批次中的索引（从 0 开始） */
    batchIndex: number;
    /** 本批次工具调用总数 */
    batchSize: number;
    /** 是否需要用户确认 */
    needsConfirmation: boolean;
}

export interface ToolProgressEvent {
    type: AgentEventType.TOOL_PROGRESS;
    turnId: string;
    toolCallId: string;
    toolName: string;
    /** 进度描述文本 */
    progress: string;
}

export interface ToolExecutionCompleteEvent {
    type: AgentEventType.TOOL_EXECUTION_COMPLETE;
    turnId: string;
    toolCallId: string;
    toolName: string;
    /** 完整的工具执行结果 */
    result: string;
    /** 截断的摘要（最长 500 字符） */
    summary: string;
    /** 是否在 UI/API 默认隐藏正文输出 */
    hideOutput?: boolean;
    /** 错误信息（执行成功则为 undefined） */
    error?: string;
}

export interface ToolErrorEvent {
    type: AgentEventType.TOOL_ERROR;
    turnId: string;
    toolCallId: string;
    toolName: string;
    error: string;
}

// ── 任务协调 ──

export interface TaskStartEvent {
    type: AgentEventType.TASK_START;
    turnId: string;
    /** 触发任务的用户查询 */
    query: string;
    /** 任务开始时间戳 (ms) */
    timestamp: number;
}

export interface TaskStepEvent {
    type: AgentEventType.TASK_STEP;
    turnId: string;
    /** 当前步骤索引（从 1 开始） */
    stepIndex: number;
    /** 本步骤的操作描述 */
    action: string;
}

export interface TaskCompleteEvent {
    type: AgentEventType.TASK_COMPLETE;
    turnId: string;
    /** 最终响应文本 */
    finalContent: string;
    /** 总工具调用次数 */
    totalToolCalls: number;
    /** 总 LLM 调用次数 */
    totalLlmCalls: number;
    /** 任务耗时 (ms) */
    elapsedMs: number;
}

export interface TaskErrorEvent {
    type: AgentEventType.TASK_ERROR;
    turnId: string;
    /** 错误信息 */
    error: string;
    /** 任务在出错前的耗时 (ms) */
    elapsedMs: number;
}

// ── 流式输出 ──

export interface StreamThinkingEvent {
    type: AgentEventType.STREAM_THINKING;
    turnId: string;
    /** 思考文本内容 */
    text: string;
}

export interface StreamAnswerEvent {
    type: AgentEventType.STREAM_ANSWER;
    turnId: string;
    /** 回答文本内容 */
    text: string;
}

// ── Token 统计 ──

export interface TokenStatsUpdateEvent {
    type: AgentEventType.TOKEN_STATS_UPDATE;
    turnId: string;
    /** 更新后的 token 统计 */
    stats: TokenStats;
}

// ── 持久化 ──

export interface HistorySaveEvent {
    type: AgentEventType.HISTORY_SAVE;
    turnId: string;
    /** 用户查询原文 */
    query: string;
    /** Agent 最终响应 */
    response: string;
    /** 工具调用记录 */
    toolCallCount: number;
}

// ── A2A / 子 Agent 通信 ──

export type AgentMessageRole = "user" | "agent" | "assistant";

export type AgentMessageChannel = "direct" | "a2a";

export interface AgentMessageEnvelope {
    protocolVersion: "a2a.v1";
    messageId: string;
    conversationId: string;
    turnId: string;
    sourceAgentId: string;
    sourceAgentName: string;
    targetAgentId?: string;
    targetAgentName?: string;
    role: AgentMessageRole;
    channel: AgentMessageChannel;
    content: string;
    timestamp: number;
}

/** A2A 消息信封 —— 所有子 Agent 事件共享的基础字段 */
interface SubAgentBase {
    /** 子 Agent 唯一 ID */
    subAgentId: string;
    /** 子 Agent 可读名称（用于 UI / @ 路由） */
    subAgentName?: string;
    /** 父级 turnId，用于关联到主 Agent 的对话轮次 */
    parentTurnId: string;
    /** 子 Agent 的任务描述（截断至 200 字符） */
    task: string;
}

export interface SubAgentStartEvent extends SubAgentBase {
    type: AgentEventType.SUB_AGENT_START;
    /** 子 Agent 使用的模型 */
    model: string;
    /** 允许的工具列表 */
    allowedTools: string[];
}

export interface SubAgentProgressEvent extends SubAgentBase {
    type: AgentEventType.SUB_AGENT_PROGRESS;
    /** 进度描述 */
    message: string;
}

export interface SubAgentCompleteEvent extends SubAgentBase {
    type: AgentEventType.SUB_AGENT_COMPLETE;
    /** 最终响应文本 */
    finalContent: string;
    /** 总工具调用次数 */
    totalToolCalls: number;
    /** 总 LLM 调用次数 */
    totalLlmCalls: number;
    /** 耗时 (ms) */
    elapsedMs: number;
}

export interface SubAgentErrorEvent extends SubAgentBase {
    type: AgentEventType.SUB_AGENT_ERROR;
    /** 错误信息 */
    error: string;
}

export interface SubAgentResultReadyEvent extends SubAgentBase {
    type: AgentEventType.SUB_AGENT_RESULT_READY;
    /** 最终响应文本 */
    finalContent: string;
    /** 耗时 (ms) */
    elapsedMs: number;
}

// ── 联合类型 ──────────────────────────────────────────────────

/**
 * 所有 AgentEvent 的判别联合类型。
 * 使用此类型进行穷尽性检查和类型安全的 dispatch。
 */
export type AgentEvent =
    | AgentInitEvent
    | AgentReadyEvent
    | AgentShutdownEvent
    | UserQueryEvent
    | UserConfirmRequestEvent
    | UserConfirmResponseEvent
    | UserCancelEvent
    | LlmRequestStartEvent
    | LlmTokenEvent
    | LlmToolCallsReceivedEvent
    | LlmResponseCompleteEvent
    | LlmErrorEvent
    | ToolExecutionStartEvent
    | ToolProgressEvent
    | ToolExecutionCompleteEvent
    | ToolErrorEvent
    | TaskStartEvent
    | TaskStepEvent
    | TaskCompleteEvent
    | TaskErrorEvent
    | StreamThinkingEvent
    | StreamAnswerEvent
    | TokenStatsUpdateEvent
    | HistorySaveEvent
    | SubAgentStartEvent
    | SubAgentProgressEvent
    | SubAgentCompleteEvent
    | SubAgentErrorEvent
    | SubAgentResultReadyEvent;

// ── 辅助类型 ──────────────────────────────────────────────────

/**
 * 事件处理器类型。
 * 可以是同步或异步的。
 */
export type EventHandler<T extends AgentEvent = AgentEvent> = (
    event: T,
) => void | Promise<void>;

/**
 * 从联合类型中提取特定事件类型的负载。
 *
 * @example
 * ```typescript
 * // Payload 被解析为 LlmTokenEvent
 * type Payload = EventPayload<AgentEventType.LLM_TOKEN>;
 * ```
 */
export type EventPayload<T extends AgentEventType> = Extract<
    AgentEvent,
    { type: T }
>;

/**
 * 事件优先级常量。
 */
export const EventPriority = {
    /** 最高优先级 —— 生命周期事件和错误 */
    HIGHEST: 0,
    /** 高优先级 —— 用户输入和控制事件 */
    HIGH: 5,
    /** 默认优先级 —— 一般任务和工具事件 */
    DEFAULT: 10,
    /** 低优先级 —— 统计和持久化事件 */
    LOW: 20,
} as const;

/**
 * 根据事件类型返回推荐的优先级。
 * 用于 MessageQueue 的自动优先级分配。
 */
export function getEventPriority(type: AgentEventType): number {
    switch (type) {
        // 生命周期事件 —— 最高优先级
        case AgentEventType.AGENT_INIT:
        case AgentEventType.AGENT_READY:
        case AgentEventType.AGENT_SHUTDOWN:
            return EventPriority.HIGHEST;

        // 错误事件 —— 最高优先级
        case AgentEventType.LLM_ERROR:
        case AgentEventType.TOOL_ERROR:
        case AgentEventType.TASK_ERROR:
            return EventPriority.HIGHEST;

        // 用户交互 —— 高优先级
        case AgentEventType.USER_QUERY:
        case AgentEventType.USER_CONFIRM_REQUEST:
        case AgentEventType.USER_CONFIRM_RESPONSE:
        case AgentEventType.USER_CANCEL:
            return EventPriority.HIGH;

        // 任务和工具事件 —— 默认优先级
        case AgentEventType.TASK_START:
        case AgentEventType.TASK_STEP:
        case AgentEventType.TASK_COMPLETE:
        case AgentEventType.LLM_REQUEST_START:
        case AgentEventType.LLM_TOKEN:
        case AgentEventType.LLM_TOOL_CALLS_RECEIVED:
        case AgentEventType.LLM_RESPONSE_COMPLETE:
        case AgentEventType.TOOL_EXECUTION_START:
        case AgentEventType.TOOL_PROGRESS:
        case AgentEventType.TOOL_EXECUTION_COMPLETE:
        case AgentEventType.STREAM_THINKING:
        case AgentEventType.STREAM_ANSWER:
            return EventPriority.DEFAULT;

        // 统计和持久化 —— 低优先级
        case AgentEventType.TOKEN_STATS_UPDATE:
        case AgentEventType.HISTORY_SAVE:
            return EventPriority.LOW;

        // A2A / 子 Agent 通信 —— 高优先级（推送通知需要快速递送）
        case AgentEventType.SUB_AGENT_START:
        case AgentEventType.SUB_AGENT_PROGRESS:
        case AgentEventType.SUB_AGENT_COMPLETE:
        case AgentEventType.SUB_AGENT_ERROR:
        case AgentEventType.SUB_AGENT_RESULT_READY:
            return EventPriority.HIGH;

        default:
            return EventPriority.DEFAULT;
    }
}
