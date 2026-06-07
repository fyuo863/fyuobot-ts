// src/agent/event-loop.ts
//
// 中央事件循环 —— 消费 MessageQueue，通过中间件管道和处理器分发事件。
//
// 处理算法：
//   1. for await (const event of this.queue) — 在空队列上阻塞
//   2. 按注册顺序运行中间件链 — 每个中间件决定是否调用 next()
//   3. 如果中间件链完成（所有中间件都调用了 next()），分发给处理器：
//      a. 特定事件类型的处理器（按注册顺序）
//      b. 通配符处理器（按注册顺序）
//      c. 每个组内的处理器并发执行（Promise.allSettled）
//   4. 如果 continueOnError 为 true，捕获处理器错误，记录日志，继续处理下一个事件
//
// 内置中间件（在 start() 时自动注册）：
//   - LoggingMiddleware: 在 DEBUG 级别将每个事件记录到 stderr
//   - TimeoutMiddleware: 将每个处理器的 dispatch 包装在 30 秒超时内

import type {
    AgentEvent,
    EventHandler,
    EventPayload,
    AgentEventType,
} from "./events.js";
import { MessageQueue } from "./message-queue.js";

// ── 类型 ──────────────────────────────────────────────────────

/** EventLoop 构造选项 */
export interface EventLoopOptions {
    /** 如果为 true，处理器中的错误不会使循环崩溃（默认 true） */
    continueOnError?: boolean;
    /** 每个事件类型的最大处理器数量 */
    maxHandlersPerType?: number;
}

/**
 * 中间件函数 —— 包装 (event, next) 模式。
 * - 调用 next() 以继续到下一个中间件/处理器。
 * - 不调用 next() 以中断链（事件被过滤）。
 * - 抛出异常以中断链并触发错误处理。
 */
export type EventMiddleware = (
    event: AgentEvent,
    next: () => Promise<void>,
) => Promise<void>;

// ── EventLoop 实现 ─────────────────────────────────────────

export class EventLoop {
    private queue: MessageQueue;
    private handlers: Map<AgentEventType, Set<EventHandler>>;
    private wildcardHandlers: Set<EventHandler>;
    private middlewareChain: EventMiddleware[];
    private continueOnError: boolean;
    private maxHandlersPerType: number;
    private _running = false;
    private abortController: AbortController | null = null;

    constructor(queue: MessageQueue, options: EventLoopOptions = {}) {
        this.queue = queue;
        this.handlers = new Map();
        this.wildcardHandlers = new Set();
        this.middlewareChain = [];
        this.continueOnError = options.continueOnError ?? true;
        this.maxHandlersPerType = options.maxHandlersPerType ?? 50;
    }

    // ── 处理器注册 ────────────────────────────────────────

    /**
     * 注册特定事件类型的处理器。
     *
     * @param type    事件类型
     * @param handler 事件处理器（类型安全的负载）
     * @returns 取消注册的函数
     */
    on<T extends AgentEventType>(
        type: T,
        handler: EventHandler<EventPayload<T>>,
    ): () => void {
        let set = this.handlers.get(type);
        if (!set) {
            set = new Set();
            this.handlers.set(type, set);
        }

        if (set.size >= this.maxHandlersPerType) {
            throw new Error(
                `事件类型 "${type}" 的处理器数量已达上限 (${this.maxHandlersPerType})`,
            );
        }

        // 类型转换：T[] -> Handler<T> -> EventHandler（内部存储需要宽类型）
        const typedHandler = handler as EventHandler;
        set.add(typedHandler);

        return () => {
            set?.delete(typedHandler);
            if (set?.size === 0) {
                this.handlers.delete(type);
            }
        };
    }

    /**
     * 一次注册多个事件类型的处理器。
     *
     * @param types   事件类型数组
     * @param handler 事件处理器
     * @returns 取消注册的函数
     */
    onMany(
        types: AgentEventType[],
        handler: EventHandler,
    ): () => void {
        const unsubs = types.map((t) => this.on(t, handler));
        return () => unsubs.forEach((fn) => fn());
    }

    /**
     * 注册通配符处理器 —— 接收所有事件。
     *
     * @param handler 事件处理器
     * @returns 取消注册的函数
     */
    onAny(handler: EventHandler): () => void {
        this.wildcardHandlers.add(handler);
        return () => {
            this.wildcardHandlers.delete(handler);
        };
    }

    // ── 中间件 ────────────────────────────────────────────

    /**
     * 向处理管道添加中间件。
     * 中间件按注册顺序执行。
     *
     * @param middleware 中间件函数
     * @returns 移除中间件的函数
     */
    use(middleware: EventMiddleware): () => void {
        this.middlewareChain.push(middleware);
        return () => {
            const idx = this.middlewareChain.indexOf(middleware);
            if (idx !== -1) {
                this.middlewareChain.splice(idx, 1);
            }
        };
    }

    // ── 生命周期 ──────────────────────────────────────────

    /**
     * 启动事件循环。
     * 在内部启动异步处理循环——此方法是非阻塞的，会立即返回。
     *
     * 自动注册内置中间件（日志记录和超时保护）。
     */
    start(): void {
        if (this._running) {
            console.warn("[EventLoop] 事件循环已在运行中");
            return;
        }

        this._running = true;
        this.abortController = new AbortController();

        // 注册内置中间件
        this.registerBuiltinMiddleware();

        // 启动异步循环
        this.runLoop().catch((err) => {
            console.error("[EventLoop] 事件循环崩溃:", err);
            this._running = false;
        });
    }

    /**
     * 优雅停止事件循环。
     * 关闭队列并等待当前正在处理的事件完成。
     */
    async stop(): Promise<void> {
        if (!this._running) return;

        this._running = false;

        // 关闭队列 —— 释放等待的异步迭代器
        this.queue.close();

        // 取消正在进行的操作
        this.abortController?.abort();
        this.abortController = null;

        // 短暂等待以确保当前事件处理完成
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    /** 事件循环是否正在运行 */
    get isRunning(): boolean {
        return this._running;
    }

    /** 底层的消息队列 */
    get messageQueue(): MessageQueue {
        return this.queue;
    }

    // ── 内部：主循环 ──────────────────────────────────────

    /**
     * 主事件处理循环。
     * 在 start() 中作为后台异步任务启动。
     */
    private async runLoop(): Promise<void> {
        const signal = this.abortController?.signal;

        for await (const event of this.queue) {
            // 检查是否应该停止
            if (signal?.aborted) {
                break;
            }

            try {
                await this.dispatchEvent(event);
            } catch (err) {
                if (this.continueOnError) {
                    console.warn(
                        `[EventLoop] 处理事件 "${event.type}" 时出错:`,
                        err instanceof Error ? err.message : String(err),
                    );
                } else {
                    // 重新抛出 —— 这会使 runLoop 崩溃
                    throw err;
                }
            }

            // 再次检查中止信号
            if (signal?.aborted) {
                break;
            }
        }

        this._running = false;
    }

    /**
     * 通过中间件链 + 处理器分发单个事件。
     */
    private async dispatchEvent(event: AgentEvent): Promise<void> {
        // 构建中间件链的执行器
        const runMiddlewareChain = async (): Promise<void> => {
            if (this.middlewareChain.length === 0) {
                // 没有中间件 —— 直接分发给处理器
                await this.dispatchToHandlers(event);
                return;
            }

            // 构建洋葱模型：从最后一个中间件开始，逐层包装
            let index = 0;

            const callNext = async (): Promise<void> => {
                if (index >= this.middlewareChain.length) {
                    // 所有中间件已执行完毕 —— 分发给处理器
                    await this.dispatchToHandlers(event);
                    return;
                }

                const middleware = this.middlewareChain[index]!;
                index++;
                await middleware(event, callNext);
            };

            await callNext();
        };

        await runMiddlewareChain();
    }

    /**
     * 将事件分发给所有注册的处理器。
     */
    private async dispatchToHandlers(event: AgentEvent): Promise<void> {
        const specificHandlers = this.handlers.get(
            event.type as AgentEventType,
        );
        const allHandlers: EventHandler[] = [];

        // 收集特定类型的处理器
        if (specificHandlers) {
            for (const h of specificHandlers) {
                allHandlers.push(h);
            }
        }

        // 收集通配符处理器
        for (const h of this.wildcardHandlers) {
            allHandlers.push(h);
        }

        if (allHandlers.length === 0) return;

        // 并发执行所有处理器
        const results = await Promise.allSettled(
            allHandlers.map((handler) =>
                this.executeHandlerWithTimeout(handler, event, 30_000),
            ),
        );

        // 记录失败的处理器
        for (const result of results) {
            if (result.status === "rejected") {
                console.warn(
                    `[EventLoop] 处理器执行失败 (事件: ${event.type}):`,
                    result.reason instanceof Error
                        ? result.reason.message
                        : String(result.reason),
                );
            }
        }
    }

    /**
     * 在超时保护内执行单个处理器。
     */
    private async executeHandlerWithTimeout(
        handler: EventHandler,
        event: AgentEvent,
        timeoutMs: number,
    ): Promise<void> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(
                    new Error(
                        `处理器超时 (${timeoutMs}ms) - 事件类型: ${event.type}`,
                    ),
                );
            }, timeoutMs);
        });

        const handlerPromise = (async () => {
            await handler(event);
        })();

        await Promise.race([handlerPromise, timeoutPromise]);
    }

    // ── 内置中间件 ────────────────────────────────────────

    private registerBuiltinMiddleware(): void {
        // 日志记录中间件
        this.use(async (event, next) => {
            if (process.env.DEBUG) {
                const brief =
                    typeof (event as { query?: string }).query === "string"
                        ? (event as { query: string }).query.slice(0, 50)
                        : "";
                console.error(
                    `[event] ${event.type}` +
                        ("turnId" in event
                            ? ` turnId=${(event as { turnId: string }).turnId}`
                            : "") +
                        (brief ? ` query="${brief}..."` : ""),
                );
            }
            await next();
        });
    }
}
