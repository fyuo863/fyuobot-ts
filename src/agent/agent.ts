// src/agent/agent.ts
import type OpenAI from "openai";
import { Router } from "../router/router.js";
import type { Task } from "../router/router.js";
import { BaseTool, ToolRegistry } from "../tools/basetool.js";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 创建一个 Agent 所需的配置 */
export interface AgentConfig {
    /** Agent 唯一名称，同时作为 Router 中的注册名 */
    name: string;
    /** 该 Agent 专属的系统提示词（决定其行为和人格） */
    systemPrompt: string;
    /** 该 Agent 可使用的工具列表（各 Agent 工具集独立） */
    tools: BaseTool[];
    /** 轮询间隔（毫秒），默认 2000 */
    pollInterval?: number;
}

/** Agent 的即时状态快照 */
export interface AgentStatus {
    name: string;
    running: boolean;
    pendingTasks: number;
    busy: boolean;
    lastActivity: string;
    toolCount: number;
}

// ── Agent 实现 ────────────────────────────────────────────────

/**
 * 独立 Agent —— 拥有自己的 LLM 上下文、工具集和自主轮询循环。
 *
 * 与 Router 的关系：
 * - 构造时自动调用 router.register(name)
 * - 轮询 router.getTask(name) 获取任务
 * - 完成后调用 router.complete() / router.fail()
 *
 * 每个 Agent 实例之间零耦合，仅通过共享 Router 交换数据。
 */
export class Agent {
    readonly name: string;
    private systemPrompt: string;
    private registry: ToolRegistry;
    private router: Router;
    private context: OpenAI.Chat.ChatCompletionMessageParam[];
    private running = false;
    private busy = false;
    private pollInterval: number;
    private _lastActivity = "";

    constructor(config: AgentConfig, router: Router) {
        this.name = config.name;
        this.systemPrompt = config.systemPrompt;
        this.router = router;
        this.pollInterval = config.pollInterval ?? 2000;

        // 构建该 Agent 专属的工具注册中心
        this.registry = new ToolRegistry();
        for (const tool of config.tools) {
            this.registry.register(tool);
        }

        // 初始化 LLM 上下文（仅含系统提示词）
        this.context = [{ role: "system", content: config.systemPrompt }];

        // 向共享 Router 报到
        this.router.register(config.name);
        this._lastActivity = "已注册";
    }

    // ── 生命周期 ──────────────────────────────────────────

    /** 启动自主轮询循环（非阻塞，fire-and-forget） */
    start(): void {
        if (this.running) return;
        this.running = true;
        this._lastActivity = "启动";
        // 启动异步循环，不阻塞调用方
        this.#pollLoop().catch((e) => {
            console.error(`[Agent ${this.name}] 轮询循环异常:`, e);
        });
    }

    /** 停止轮询（当前正在执行的任务会继续完成） */
    stop(): void {
        this.running = false;
        this._lastActivity = "已停止";
    }

    /** 即时状态快照 */
    get status(): AgentStatus {
        return {
            name: this.name,
            running: this.running,
            pendingTasks: this.router.pendingCount(this.name),
            busy: this.busy,
            lastActivity: this._lastActivity,
            toolCount: this.registry.size,
        };
    }

    // ── 内部：轮询循环 ─────────────────────────────────────

    /**
     * 持续轮询 Router，发现待处理任务后交给 LLM 执行。
     * 使用 while+sleep 模式，避免 setInterval 的并发重叠风险。
     */
    async #pollLoop(): Promise<void> {
        while (this.running) {
            const task = this.router.getTask(this.name);
            if (task) {
                this._lastActivity = `执行: ${task.id}`;
                await this.#executeTask(task);
            }
            // 等待后进入下一轮
            await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        }
    }

    // ── 内部：执行单个任务 ─────────────────────────────────

    async #executeTask(task: Task): Promise<void> {
        this.busy = true;

        // 将任务拼装为 user 消息注入 LLM 上下文
        const taskPrompt = [
            `--- 📋 新任务 ---`,
            `ID:     ${task.id}`,
            `来源:   ${task.from}`,
            `类型:   ${task.type}`,
            `负载:   ${JSON.stringify(task.payload, null, 2)}`,
            `-------------------`,
            `请执行上述任务。使用你拥有的工具来完成任务，完成后简要说明结果。`,
        ].join("\n");

        this.context.push({ role: "user", content: taskPrompt });

        try {
            let result: SendResult;
            do {
                result = await sendMessage(this.context, {
                    tools: this.registry.toOpenAITools(),
                });

                this.context.push({
                    role: "assistant",
                    content: result.content || null,
                    ...(result.toolCalls?.length
                        ? { tool_calls: result.toolCalls }
                        : {}),
                });

                // 执行工具调用
                if (result.toolCalls?.length) {
                    for (const tc of result.toolCalls) {
                        this._lastActivity = `工具: ${tc.function.name}`;
                        const args = JSON.parse(
                            tc.function.arguments,
                        ) as Record<string, unknown>;
                        const toolResult = await this.registry.execute(
                            tc.function.name,
                            args,
                        );
                        this.context.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: toolResult,
                        });
                    }
                }
            } while (result.toolCalls?.length);

            // 任务完成
            this.router.complete(task.id, {
                agent: this.name,
                response: result.content || "任务完成（无文本输出）",
            });
            this._lastActivity = `✅ 完成: ${task.id}`;
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            this.router.fail(task.id, errMsg);
            this._lastActivity = `❌ 失败: ${task.id}`;
        } finally {
            this.busy = false;
        }
    }
}
