// src/agent/tool-executor.ts
//
// 并发工具批量执行器 —— 从 agent-task 的核心循环中提取。
//
// 并发模型：
//   1. 将工具调用分区：危险工具 → 顺序队列；安全工具 → 并行池
//   2. 危险工具：逐个执行，每次执行前等待用户确认
//   3. 安全工具：通过 Promise.allSettled 并行执行
//       - 具有相同 concurrencyKey 的安全工具会按组分批串行化
//       - 默认并发限制：无限制（一次全部并行）
//   4. 每个工具的执行：发出 TOOL_EXECUTION_START → TOOL_PROGRESS → TOOL_EXECUTION_COMPLETE
//   5. 结果按原始顺序返回（以保持正确的 LLM 上下文位置）
//   6. 每个工具 5 分钟超时

import { AgentEventType } from "./events.js";
import type {
    ToolExecutionStartEvent,
    ToolProgressEvent,
    ToolExecutionCompleteEvent,
} from "./events.js";
import { EventPriority } from "./events.js";
import type { MessageQueue } from "./message-queue.js";
import type { ToolRegistry } from "../tools/basetool.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 单个工具执行项 */
export interface ToolExecutionItem {
    /** LLM 工具调用的唯一 ID */
    toolCallId: string;
    /** 工具名称 */
    toolName: string;
    /** 已解析的参数对象 */
    args: Record<string, unknown>;
}

/** 单个工具执行结果 */
export interface ToolExecutionResult {
    /** LLM 工具调用的唯一 ID */
    toolCallId: string;
    /** 工具名称 */
    toolName: string;
    /** 完整的执行结果文本 */
    result: string;
    /** 截断的摘要（最长 500 字符） */
    summary: string;
    /** 错误信息（执行成功则为 undefined） */
    error?: string;
}

/** executeToolBatch 的选项 */
export interface ExecuteToolBatchOptions {
    /** 安全工具的最大并行数（默认无限制 = Infinity） */
    maxConcurrency?: number;
    /** 每个工具的单独超时时间（默认 5 分钟） */
    toolTimeoutMs?: number;
}

// ── 执行函数 ──────────────────────────────────────────────────

/**
 * 执行一批工具调用，处理确认流程，并通过事件总线报告进度。
 *
 * 并发逻辑：
 *   1. 分区：危险工具 → sequential；安全工具 → parallel
 *   2. 处理危险工具：逐个执行，每次执行前通过 confirmFn 请求用户批准
 *   3. 处理安全工具：Promise.allSettled（受 maxConcurrency 限制）
 *   4. 事件在整个过程中发出（TOOL_EXECUTION_START、TOOL_PROGRESS、TOOL_EXECUTION_COMPLETE）
 *   5. 结果按原始顺序返回
 *
 * @param items    要执行的工具调用项
 * @param registry 工具注册中心
 * @param bus      用于发出事件的 MessageQueue
 * @param turnId   当前对话轮次的 ID
 * @param confirmFn 需要用户确认时调用的函数
 * @param options  并发和超时选项
 */
export async function executeToolBatch(
    items: ToolExecutionItem[],
    registry: ToolRegistry,
    bus: MessageQueue,
    turnId: string,
    confirmFn: (
        toolName: string,
        args: Record<string, unknown>,
    ) => Promise<{ approved: boolean; feedback?: string }>,
    options: ExecuteToolBatchOptions = {},
): Promise<ToolExecutionResult[]> {
    const { maxConcurrency = Infinity, toolTimeoutMs = 300_000 } = options;

    if (items.length === 0) return [];

    // ── 步骤 1：分区 ──────────────────────────────────────

    interface PartitionedItem extends ToolExecutionItem {
        originalIndex: number;
        dangerous: boolean;
        concurrencyKey?: string;
    }

    const partitioned: PartitionedItem[] = items.map((item, i) => {
        const tool = registry.get(item.toolName);
        const dangerous = tool?.dangerous ?? false;
        const concurrencyKey = tool?.concurrencyKey ?? item.toolName;
        return {
            ...item,
            originalIndex: i,
            dangerous,
            concurrencyKey,
        };
    });

    // ── 步骤 2：全部结果数组（按原始索引填充） ──────────────

    const results: (ToolExecutionResult | null)[] = new Array(
        items.length,
    ).fill(null);

    // ── 步骤 2a：处理危险工具（顺序，每次确认后执行） ──────

    const dangerousItems = partitioned.filter((p) => p.dangerous);

    for (const item of dangerousItems) {
        // 确认
        const confirm = await confirmFn(item.toolName, item.args);

        if (!confirm.approved) {
            const feedback = confirm.feedback
                ? `\n[用户反馈]: ${confirm.feedback}`
                : "\n[用户反馈]: 用户拒绝了此操作，没有提供额外说明";
            const cancelMsg =
                `❌ 用户拒绝了敏感操作: ${item.toolName}\n` +
                `[原始参数]: ${JSON.stringify(item.args)}${feedback}\n` +
                `[提示]: 请根据用户反馈调整操作方案，如需执行替代命令请在下次调用时修改参数`;

            results[item.originalIndex] = {
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                result: cancelMsg,
                summary: cancelMsg.slice(0, 500),
            };

            // 发出事件
            const startEvent: ToolExecutionStartEvent = {
                type: AgentEventType.TOOL_EXECUTION_START,
                turnId,
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                args: item.args,
                batchIndex: item.originalIndex,
                batchSize: items.length,
                needsConfirmation: true,
            };
            bus.enqueue(startEvent, EventPriority.DEFAULT);

            const completeEvent: ToolExecutionCompleteEvent = {
                type: AgentEventType.TOOL_EXECUTION_COMPLETE,
                turnId,
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                result: cancelMsg,
                summary: cancelMsg.slice(0, 500),
            };
            bus.enqueue(completeEvent, EventPriority.DEFAULT);

            continue;
        }

        // 已批准 —— 执行
        const result = await executeSingleTool(
            item,
            registry,
            bus,
            turnId,
            toolTimeoutMs,
        );
        results[item.originalIndex] = result;
    }

    // ── 步骤 2b：处理安全工具（按 concurrencyKey 分组并行） ──

    const safeItems = partitioned.filter((p) => !p.dangerous);

    // 按 concurrencyKey 分组，相同 key 的工具需串行化
    const groups: Map<string, PartitionedItem[]> = new Map();
    for (const item of safeItems) {
        const key = item.concurrencyKey ?? `_default_${item.toolCallId}`;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(item);
    }

    // 并行执行每个组（组内串行）
    const groupPromises = Array.from(groups.values()).map((group) =>
        executeSequentialGroup(
            group,
            registry,
            bus,
            turnId,
            toolTimeoutMs,
        ),
    );

    // 限制并发数
    if (maxConcurrency < Infinity && groupPromises.length > maxConcurrency) {
        // 分批执行
        const groupResults: Array<
            Array<{ item: PartitionedItem; result: ToolExecutionResult }>
        > = [];
        for (let i = 0; i < groupPromises.length; i += maxConcurrency) {
            const batch = groupPromises.slice(i, i + maxConcurrency);
            const batchResults = await Promise.allSettled(batch);
            for (const r of batchResults) {
                if (r.status === "fulfilled") {
                    groupResults.push(r.value);
                } else {
                    console.warn(
                        "[tool-executor] 工具组执行失败:",
                        r.reason instanceof Error
                            ? r.reason.message
                            : String(r.reason),
                    );
                }
            }
        }
        for (const groupResult of groupResults) {
            for (const { item, result } of groupResult) {
                results[item.originalIndex] = result;
            }
        }
    } else {
        const settled = await Promise.allSettled(groupPromises);
        for (const s of settled) {
            if (s.status === "fulfilled") {
                for (const { item, result } of s.value) {
                    results[item.originalIndex] = result;
                }
            } else {
                console.warn(
                    "[tool-executor] 工具组执行失败:",
                    s.reason instanceof Error
                        ? s.reason.message
                        : String(s.reason),
                );
            }
        }
    }

    // ── 步骤 3：返回结果（过滤掉 null —— 极端情况下的安全网） ──

    return results.filter((r): r is ToolExecutionResult => r !== null);
}

// ── 内部辅助函数 ──────────────────────────────────────────────

/**
 * 顺序执行一组工具项。
 * 用于串行化组（相同的 concurrencyKey）或危险工具列表。
 */
async function executeSequentialGroup(
    items: PartitionedItem[],
    registry: ToolRegistry,
    bus: MessageQueue,
    turnId: string,
    timeoutMs: number,
): Promise<Array<{ item: PartitionedItem; result: ToolExecutionResult }>> {
    const results: Array<{ item: PartitionedItem; result: ToolExecutionResult }> =
        [];

    for (const item of items) {
        const result = await executeSingleTool(
            item,
            registry,
            bus,
            turnId,
            timeoutMs,
        );
        results.push({ item, result });
    }

    return results;
}

/**
 * 执行单个工具，包括事件发出和超时保护。
 */
async function executeSingleTool(
    item: PartitionedItem,
    registry: ToolRegistry,
    bus: MessageQueue,
    turnId: string,
    timeoutMs: number,
): Promise<ToolExecutionResult> {
    // 发出开始事件
    const startEvent: ToolExecutionStartEvent = {
        type: AgentEventType.TOOL_EXECUTION_START,
        turnId,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        args: item.args,
        batchIndex: item.originalIndex,
        batchSize: 0, // 将在调用方设置，这里使用 originalIndex
        needsConfirmation: false,
    };
    bus.enqueue(startEvent, EventPriority.DEFAULT);

    // 带超时的执行
    try {
        const toolResult = await executeWithTimeout(
            () =>
                registry.execute(item.toolName, item.args, (progress) => {
                    // 发出进度事件
                    const progressEvent: ToolProgressEvent = {
                        type: AgentEventType.TOOL_PROGRESS,
                        turnId,
                        toolCallId: item.toolCallId,
                        toolName: item.toolName,
                        progress,
                    };
                    bus.enqueue(progressEvent, EventPriority.DEFAULT);
                }),
            timeoutMs,
        );

        // 生成摘要
        const summary =
            toolResult.length > 500
                ? toolResult.slice(0, 500) + "\n... (已截断)"
                : toolResult;

        // 发出完成事件
        const completeEvent: ToolExecutionCompleteEvent = {
            type: AgentEventType.TOOL_EXECUTION_COMPLETE,
            turnId,
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            result: toolResult,
            summary,
        };
        bus.enqueue(completeEvent, EventPriority.DEFAULT);

        return {
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            result: toolResult,
            summary,
        };
    } catch (error) {
        const errorMsg =
            error instanceof Error ? error.message : String(error);
        const errorResult = `Error executing "${item.toolName}": ${errorMsg}`;

        // 发出带有错误字段的完成事件
        const completeEvent: ToolExecutionCompleteEvent = {
            type: AgentEventType.TOOL_EXECUTION_COMPLETE,
            turnId,
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            result: errorResult,
            summary: errorResult.slice(0, 500),
            error: errorMsg,
        };
        bus.enqueue(completeEvent, EventPriority.DEFAULT);

        return {
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            result: errorResult,
            summary: errorResult.slice(0, 500),
            error: errorMsg,
        };
    }
}

/**
 * 对 Promise 进行超时包装。
 */
async function executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
): Promise<T> {
    if (timeoutMs <= 0) return fn();

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
            reject(new Error(`工具执行超时 (${timeoutMs}ms)`));
        }, timeoutMs);
    });

    return Promise.race([fn(), timeoutPromise]);
}

// ── 为 PartitionedItem 添加内部类型 ──────────────────────────

interface PartitionedItem extends ToolExecutionItem {
    originalIndex: number;
    dangerous: boolean;
    concurrencyKey?: string;
}
