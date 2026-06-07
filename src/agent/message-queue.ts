// src/agent/message-queue.ts
//
// 优先级消息队列 —— 事件驱动架构的中央总线。
//
// 特性：
//   - 基于最小堆的优先级排序，O(log n) 出队
//   - 异步迭代器支持（EventLoop 可通过 for await 消费）
//   - 轻量级 pub/sub（subscribe() 不经过队列，同步触发）
//   - 背压保护（maxSize 超限时丢弃最旧的最低优先级消息）
//
// 优先级约定：
//   0  = 最高（生命周期、错误）
//   5  = 高（用户交互）
//   10 = 默认（任务、工具、LLM 事件）
//   20 = 低（统计、持久化）

import type { AgentEvent, AgentEventType } from "./events.js";
import { getEventPriority } from "./events.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 队列中的消息包装 */
export interface QueuedMessage {
    /** 消息唯一 ID */
    id: string;
    /** 事件负载 */
    event: AgentEvent;
    /** 优先级（越小越优先） */
    priority: number;
    /** 入队时间戳 (ms) */
    enqueuedAt: number;
}

/** MessageQueue 构造选项 */
export interface MessageQueueOptions {
    /** 最大容量（默认 1000）。超限时丢弃最旧的最低优先级消息。 */
    maxSize?: number;
    /** 默认优先级（默认 10） */
    defaultPriority?: number;
}

/** 订阅过滤器类型 */
type EventFilter =
    | AgentEventType
    | AgentEventType[]
    | ((event: AgentEvent) => boolean);

/** 订阅处理器 */
type Subscriber = {
    filter: EventFilter;
    handler: (event: AgentEvent) => void | Promise<void>;
};

// ── 最小堆实现 ──────────────────────────────────────────────

/**
 * 简单的最小堆，按 (priority, enqueuedAt) 排序。
 */
class MinHeap<T extends { priority: number; enqueuedAt: number }> {
    private items: T[] = [];

    get size(): number {
        return this.items.length;
    }

    get isEmpty(): boolean {
        return this.items.length === 0;
    }

    push(item: T): void {
        this.items.push(item);
        this.siftUp(this.items.length - 1);
    }

    pop(): T | undefined {
        if (this.items.length === 0) return undefined;
        if (this.items.length === 1) return this.items.pop()!;

        const top = this.items[0]!;
        const last = this.items.pop()!;
        this.items[0] = last;
        this.siftDown(0);
        return top;
    }

    peek(): T | undefined {
        return this.items[0];
    }

    /** 移除并返回优先级最低（数值最大）的元素。O(n) 最坏情况。 */
    popLowestPriority(): T | undefined {
        if (this.items.length === 0) return undefined;

        // Safe: items.length >= 1 verified above
        const first = this.items[0]!;
        let lowestIdx = 0;
        let lowestPriority = first.priority;
        let latestTime = first.enqueuedAt;

        for (let i = 1; i < this.items.length; i++) {
            const item = this.items[i]!;
            if (
                item.priority > lowestPriority ||
                (item.priority === lowestPriority &&
                    item.enqueuedAt > latestTime)
            ) {
                lowestIdx = i;
                lowestPriority = item.priority;
                latestTime = item.enqueuedAt;
            }
        }

        const removed = this.items[lowestIdx]!;
        const last = this.items.pop()!;

        if (lowestIdx < this.items.length) {
            this.items[lowestIdx] = last;
            // 需要同时检查上浮和下沉
            if (lowestIdx > 0) {
                const parent = Math.floor((lowestIdx - 1) / 2);
                if (
                    this.compare(this.items[lowestIdx]!, this.items[parent]!) < 0
                ) {
                    this.siftUp(lowestIdx);
                } else {
                    this.siftDown(lowestIdx);
                }
            } else {
                this.siftDown(lowestIdx);
            }
        }
        return removed;
    }

    clear(): void {
        this.items.length = 0;
    }

    private compare(a: T, b: T): number {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.enqueuedAt - b.enqueuedAt;
    }

    private siftUp(idx: number): void {
        let i = idx;
        while (i > 0) {
            const parent = Math.floor((i - 1) / 2);
            const current = this.items[i]!;
            const parentItem = this.items[parent]!;
            if (this.compare(current, parentItem) < 0) {
                this.items[i] = parentItem;
                this.items[parent] = current;
                i = parent;
            } else {
                break;
            }
        }
    }

    private siftDown(idx: number): void {
        const size = this.items.length;
        let i = idx;
        while (true) {
            let smallest = i;
            const left = 2 * i + 1;
            const right = 2 * i + 2;

            if (
                left < size &&
                this.compare(this.items[left]!, this.items[smallest]!) < 0
            ) {
                smallest = left;
            }
            if (
                right < size &&
                this.compare(this.items[right]!, this.items[smallest]!) < 0
            ) {
                smallest = right;
            }
            if (smallest !== i) {
                const tmp = this.items[i]!;
                this.items[i] = this.items[smallest]!;
                this.items[smallest] = tmp;
                i = smallest;
            } else {
                break;
            }
        }
    }
}

// ── MessageQueue 实现 ───────────────────────────────────────

export class MessageQueue {
    private heap: MinHeap<QueuedMessage>;
    private maxSize: number;
    private defaultPriority: number;
    private messageCounter: number;

    /** 异步迭代器的等待者队列 */
    private waiters: Array<{
        resolve: (event: AgentEvent) => void;
        reject: (error: Error) => void;
    }> = [];

    /** 订阅者列表 */
    private subscribers: Subscriber[] = [];

    /** 队列是否已关闭 */
    private closed = false;

    constructor(options: MessageQueueOptions = {}) {
        this.heap = new MinHeap();
        this.maxSize = options.maxSize ?? 1000;
        this.defaultPriority = options.defaultPriority ?? 10;
        this.messageCounter = 0;
    }

    // ── 入队 ──────────────────────────────────────────────

    /**
     * 将单个事件入队。
     * 如果未指定优先级，则根据事件类型自动分配。
     */
    enqueue(event: AgentEvent, priority?: number): void {
        if (this.closed) {
            console.warn("[MessageQueue] 队列已关闭，忽略入队事件:", event.type);
            return;
        }

        const effectivePriority =
            priority ?? getEventPriority(event.type as AgentEventType) ?? this.defaultPriority;

        const message: QueuedMessage = {
            id: `msg_${++this.messageCounter}_${Date.now()}`,
            event,
            priority: effectivePriority,
            enqueuedAt: Date.now(),
        };

        // 背压保护
        if (this.heap.size >= this.maxSize) {
            const dropped = this.heap.popLowestPriority();
            console.warn(
                `[MessageQueue] 队列已满 (${this.maxSize})，丢弃低优先级消息:`,
                dropped?.event.type ?? "unknown",
            );
        }

        this.heap.push(message);

        // 通知等待中的消费者
        this.notifyWaiters();
    }

    /**
     * 批量入队多个事件（原子操作）。
     */
    enqueueBatch(events: AgentEvent[], priority?: number): void {
        for (const event of events) {
            this.enqueue(event, priority);
        }
    }

    // ── 出队 ──────────────────────────────────────────────

    /**
     * 同步出队 —— 从堆中取出优先级最高的消息。
     * 如果队列为空，返回 null。
     */
    dequeue(): QueuedMessage | null {
        if (this.closed && this.heap.isEmpty) return null;
        return this.heap.pop() ?? null;
    }

    // ── 异步迭代器 ────────────────────────────────────────

    /**
     * 异步迭代器 —— EventLoop 的核心消费方式。
     *
     * 当队列为空时，迭代器会阻塞（通过 Promise），
     * 直到有新消息入队或队列被关闭。
     *
     * @example
     * ```typescript
     * for await (const event of messageQueue) {
     *     // 处理事件
     * }
     * ```
     */
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        while (true) {
            // 先检查队列中是否有待处理的消息
            const message = this.dequeue();
            if (message) {
                yield message.event;

                // 通知订阅者（同步路径）
                this.notifySubscribers(message.event);
                continue;
            }

            // 队列为空且已关闭 —— 退出循环
            if (this.closed) {
                return;
            }

            // 队列为空但未关闭 —— 等待新消息
            try {
                const event = await new Promise<AgentEvent>(
                    (resolve, reject) => {
                        this.waiters.push({ resolve, reject });
                    },
                );
                yield event;

                // 通知订阅者（经由异步迭代器的消息）
                this.notifySubscribers(event);
            } catch {
                // 等待被中断（例如 stop() 被调用）
                return;
            }
        }
    }

    // ── Pub/Sub ───────────────────────────────────────────

    /**
     * 订阅匹配过滤器的事件。
     *
     * 订阅者的处理器会在事件 yield 之后立即被调用（同步或 Promise-flushed），
     * 不经过队列的出队路径。适合 fire-and-forget 场景（日志、分析等）。
     *
     * @param filter 过滤器：单个事件类型、事件类型数组、或自定义函数
     * @param handler 事件处理器
     * @returns 取消订阅的函数
     */
    subscribe(
        filter: EventFilter,
        handler: (event: AgentEvent) => void | Promise<void>,
    ): () => void {
        const subscriber: Subscriber = { filter, handler };
        this.subscribers.push(subscriber);

        return () => {
            const idx = this.subscribers.indexOf(subscriber);
            if (idx !== -1) {
                this.subscribers.splice(idx, 1);
            }
        };
    }

    // ── 生命周期 ──────────────────────────────────────────

    /** 当前队列大小 */
    get size(): number {
        return this.heap.size;
    }

    /** 队列是否为空 */
    get isEmpty(): boolean {
        return this.heap.isEmpty;
    }

    /** 订阅者数量 */
    get subscriberCount(): number {
        return this.subscribers.length;
    }

    /** 清空队列中的所有消息（不移除订阅者或等待者） */
    clear(): void {
        this.heap.clear();
    }

    /**
     * 关闭队列 —— 不再接受新消息，释放等待中的异步迭代器。
     * 关闭后队列中剩余的消息仍可被 dequeue() 取出。
     */
    close(): void {
        this.closed = true;
        // 通知所有等待者 —— 通过 reject 中断等待
        for (const waiter of this.waiters) {
            waiter.reject(new Error("QUEUE_CLOSED"));
        }
        this.waiters.length = 0;
    }

    /** 队列是否已关闭 */
    get isClosed(): boolean {
        return this.closed;
    }

    // ── 内部方法 ──────────────────────────────────────────

    /**
     * 通知等待中的异步迭代器消费者。
     */
    private notifyWaiters(): void {
        while (this.waiters.length > 0 && this.heap.size > 0) {
            const message = this.dequeue();
            if (message) {
                const waiter = this.waiters.shift()!;
                waiter.resolve(message.event);
            }
        }
    }

    /**
     * 通知匹配的订阅者。
     */
    private notifySubscribers(event: AgentEvent): void {
        for (const sub of this.subscribers) {
            if (this.matchesFilter(sub.filter, event)) {
                try {
                    const result = sub.handler(event);
                    // 如果是 Promise，捕获异步错误
                    if (result instanceof Promise) {
                        result.catch((err) => {
                            console.warn(
                                `[MessageQueue] 订阅者处理出错:`,
                                err instanceof Error ? err.message : String(err),
                            );
                        });
                    }
                } catch (err) {
                    console.warn(
                        `[MessageQueue] 订阅者处理出错:`,
                        err instanceof Error ? err.message : String(err),
                    );
                }
            }
        }
    }

    private matchesFilter(
        filter: EventFilter,
        event: AgentEvent,
    ): boolean {
        if (typeof filter === "function") {
            return filter(event);
        }
        if (Array.isArray(filter)) {
            return filter.includes(event.type as AgentEventType);
        }
        return filter === event.type;
    }
}
