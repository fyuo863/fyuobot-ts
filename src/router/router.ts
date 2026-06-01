/**
 * Router — 多 Agent 任务路由与数据存储中心。
 *
 * 职责：
 *  1. 注册 Agent（name → handler），支持回调通知和轮询两种模式
 *  2. 持久化存储所有任务数据，支持按状态/目标查询
 *  3. 任务完成后可链式触发 nextTasks，实现多步骤工作流
 *
 * 典型工作流：
 *   Main → publish(coder) → Coder 检测 → 执行 →
 *   publish(reviewer, filePath) → Reviewer 检测 → 审查 →
 *   publish(coder, fix) 或 publish(main, done)
 */

// ── 类型定义 ──────────────────────────────────────────────

/** 任务发布时的输入（不含自动生成字段） */
export interface PublishTask {
    /** 目标 Agent 名称 */
    to: string;
    /** 来源 Agent 名称 */
    from: string;
    /** 任务类型标签，如 "code" | "review" | "fix" */
    type: string;
    /** 任务携带的数据 */
    payload: Record<string, unknown>;
    /** 本任务完成后自动发布的后续任务（链式触发） */
    nextTasks?: PublishTask[];
}

/** 任务状态 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

/** 完整的任务对象 */
export interface Task {
    /** 唯一标识 */
    id: string;
    /** 目标 Agent */
    to: string;
    /** 来源 Agent */
    from: string;
    /** 任务类型 */
    type: string;
    /** 携带数据 */
    payload: Record<string, unknown>;
    /** 当前状态 */
    status: TaskStatus;
    /** 完成/失败时的返回数据 */
    result?: Record<string, unknown>;
    /** 失败时的错误信息 */
    error?: string;
    /** 完成后自动发布的后续任务模板 */
    nextTasks?: PublishTask[]| undefined;
    /** 创建时间戳 */
    createdAt: number;
    /** 最后更新时间戳 */
    updatedAt: number;
}

/** Agent 任务处理函数签名 */
export type AgentHandler = (task: Task) => Promise<Record<string, unknown>>;

/** 任务查询过滤条件 */
export interface TaskFilter {
    to?: string;
    from?: string;
    type?: string;
    status?: TaskStatus | TaskStatus[];
}

// ── 工具函数 ──────────────────────────────────────────────

let taskCounter = 0;
function nextId(): string {
    return `task_${Date.now()}_${++taskCounter}`;
}

// ── Router 实现 ────────────────────────────────────────────

export class Router {
    /** 已注册的 Agent 名称集合 */
    private agents = new Set<string>();

    /** 每个 Agent 对应的任务处理函数（回调模式） */
    private handlers = new Map<string, AgentHandler>();

    /** 全部任务存储：id → Task */
    private tasks = new Map<string, Task>();

    /**
     * 注册一个 Agent。注册后该名称才能接收任务。
     * 可重复调用以更新 handler（覆盖旧的）。
     */
    register(name: string): void {
        this.agents.add(name);
    }

    /**
     * 为 Agent 注册回调处理函数。
     * 当有新任务发布到该 Agent 时，handler 会被异步调用。
     * 调用此方法会自动 register 该 Agent。
     *
     * @param name    Agent 名称
     * @param handler 任务处理函数，接收 Task，返回结果数据
     */
    onTask(name: string, handler: AgentHandler): void {
        this.register(name);
        this.handlers.set(name, handler);
    }

    /**
     * 发布一个任务到指定 Agent。
     * 如果该 Agent 注册了 onTask 回调，会异步触发处理。
     *
     * @returns 生成的任务 ID
     */
    publish(task: PublishTask): string {
        if (!this.agents.has(task.to)) {
            console.warn(`⚠ Router.publish: 目标 Agent "${task.to}" 未注册，任务将保持 pending。`);
        }

        const id = nextId();
        const now = Date.now();

        const fullTask: Task = {
            id,
            to: task.to,
            from: task.from,
            type: task.type,
            payload: task.payload,
            status: "pending",
            nextTasks: task.nextTasks,
            createdAt: now,
            updatedAt: now,
        };

        this.tasks.set(id, fullTask);

        // 异步触发回调（如果已注册）
        const handler = this.handlers.get(task.to);
        if (handler) {
            // 延迟到下一个微任务执行，避免回调内部的 publish 递归爆栈
            Promise.resolve().then(() => this.#executeHandler(fullTask, handler));
        }

        return id;
    }

    /**
     * 轮询模式：获取指定 Agent 的下一个 pending 任务。
     * 返回的任务自动标记为 in_progress。
     *
     * @returns 任务对象，若无待处理任务则返回 null
     */
    getTask(agentName: string): Task | null {
        const pending = this.getTasks({ to: agentName, status: "pending" });
        if (pending.length === 0) return null;

        const task = pending[0]!;
        task.status = "in_progress";
        task.updatedAt = Date.now();
        return task;
    }

    /**
     * 标记任务为完成，并存储结果。
     * 如果任务定义了 nextTasks，会自动发布后续任务。
     *
     * @param id     任务 ID
     * @param result 任务返回的数据
     */
    complete(id: string, result: Record<string, unknown>): void {
        const task = this.tasks.get(id);
        if (!task) {
            console.warn(`⚠ Router.complete: 任务 "${id}" 不存在。`);
            return;
        }

        task.status = "completed";
        task.result = result;
        task.updatedAt = Date.now();

        // 链式发布后续任务
        if (task.nextTasks?.length) {
            for (const next of task.nextTasks) {
                this.publish(next);
            }
        }
    }

    /**
     * 标记任务为失败，并记录错误信息。
     *
     * @param id    任务 ID
     * @param error 错误描述
     */
    fail(id: string, error: string): void {
        const task = this.tasks.get(id);
        if (!task) {
            console.warn(`⚠ Router.fail: 任务 "${id}" 不存在。`);
            return;
        }

        task.status = "failed";
        task.error = error;
        task.updatedAt = Date.now();
    }

    // ── 查询接口 ────────────────────────────────────────

    /** 根据过滤条件查询任务列表（按创建时间升序） */
    getTasks(filter: TaskFilter = {}): Task[] {
        const statusSet = filter.status
            ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
            : null;

        return [...this.tasks.values()]
            .filter((t) => {
                if (filter.to !== undefined && t.to !== filter.to) return false;
                if (filter.from !== undefined && t.from !== filter.from) return false;
                if (filter.type !== undefined && t.type !== filter.type) return false;
                if (statusSet && !statusSet.has(t.status)) return false;
                return true;
            })
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /** 根据 ID 获取单个任务 */
    getTaskById(id: string): Task | undefined {
        return this.tasks.get(id);
    }

    /** Agent 的 pending 任务计数 */
    pendingCount(agentName: string): number {
        return this.getTasks({ to: agentName, status: "pending" }).length;
    }

    /** 所有已注册的 Agent 名称列表 */
    get registeredAgents(): string[] {
        return [...this.agents];
    }

    /** 总任务数 */
    get totalTasks(): number {
        return this.tasks.size;
    }

    // ── 内部方法 ────────────────────────────────────────

    /** 执行 handler，处理异常并自动 complete/fail */
    async #executeHandler(task: Task, handler: AgentHandler): Promise<void> {
        try {
            const result = await handler(task);
            this.complete(task.id, result);
        } catch (e) {
            this.fail(task.id, e instanceof Error ? e.message : String(e));
        }
    }
}
