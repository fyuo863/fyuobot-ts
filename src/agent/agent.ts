// src/agent/agent.ts
import type OpenAI from "openai";
import { ToolRegistry } from "../tools/basetool.js";
import { MessageQueue } from "./message-queue.js";
import { getEventPriority, AgentEventType as ET } from "./events.js";
import type { HistorySaveEvent } from "./events.js";
import { runAgentTask } from "./agent-task.js";
import { loadUserPreferences, loadSystemSettings } from "./prompts.js";

// ── 类型 ──────────────────────────────────────────────────────

/** 创建一个 Agent 所需的配置 */
export interface AgentConfig {
    /** Agent 唯一名称 */
    name: string;
    /**
     * Layer 1 — 核心系统提示词（不经常变动的内容：工具描述、工作规则等）。
     * 放在消息数组最前面，作为 LLM prompt cache 的缓存前缀。
     */
    systemPrompt: string;
    /**
     * Layer 2 — Agent 身份设定（相对易变的内容：角色、人格等）。
     * 放在核心系统提示词之后，切换 agent 时才变化。
     * 可选：不提供则只有一层系统提示词。
     */
    identity?: string;
}

/** Agent 的即时状态快照 */
export interface AgentStatus {
    name: string;
    busy: boolean;
    lastActivity: string;
    toolCount: number;
}

/** runTask 的选项 */
export interface RunTaskOptions {
    /**
     * 确认函数 —— 当工具标记为 dangerous 时调用。
     * 如果不提供，危险工具将直接执行（无确认）。
     */
    confirmFn?: (
        toolName: string,
        args: Record<string, unknown>,
    ) => Promise<{ approved: boolean; feedback?: string }>;
}

// ── Agent 实现 ────────────────────────────────────────────────

/**
 * 单 Agent —— 接收用户查询，运行 LLM 工具调用循环，返回最终响应。
 *
 * 每个 Agent 持有一个 ToolRegistry，工具由外部统一注入。
 * 事件通过 MessageQueue 发出，供 TUI、日志、分析等消费者使用。
 */
export class Agent {
    readonly name: string;
    /** Layer 1 — 核心系统提示词（缓存前缀） */
    private systemPrompt: string;
    /** Layer 2 — Agent 身份设定（可选） */
    private identity: string | undefined;
    readonly registry: ToolRegistry;
    /** 事件总线 —— 所有可观察事件通过此队列发出 */
    readonly bus: MessageQueue;
    private _busy = false;
    private _lastActivity = "";
    /** 轮次计数器，用于生成唯一的 turnId */
    private _turnCounter = 0;

    constructor(
        config: AgentConfig,
        registry: ToolRegistry,
        bus: MessageQueue,
    ) {
        this.name = config.name;
        this.systemPrompt = config.systemPrompt;
        this.identity = config.identity;
        this.registry = registry;
        this.bus = bus;
        this._lastActivity = "已就绪";
    }

    // ── 状态 ──────────────────────────────────────────────

    /** 即时状态快照 */
    get status(): AgentStatus {
        return {
            name: this.name,
            busy: this._busy,
            lastActivity: this._lastActivity,
            toolCount: this.registry.size,
        };
    }

    // ── 任务执行（对外接口）─────────────────────────────────

    /**
     * 构建用于 LLM 调用的初始消息上下文。
     *
     * 消息按缓存优化顺序排列（由稳定到易变）：
     *   1. Agent 身份（永不变 —— 缓存锚点）
     *   2. 用户偏好 USER.md（极少变动）
     *   3. 系统设置 MEMORY.md（极少变动）
     *   4. 核心系统提示词（偶尔变动）
     *   5. 用户查询（每次变动）
     */
    private buildContext(
        query: string,
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

        // Layer 1: Agent 身份（最稳定，缓存锚点）
        if (this.identity) {
            messages.push({ role: "system", content: this.identity });
        }

        // Layer 2: 用户偏好（USER.md）
        const userPrefs = loadUserPreferences();
        if (userPrefs) {
            messages.push({
                role: "system",
                content: `[用户偏好 — .fyuobot/memories/USER.md]\n${userPrefs}`,
            });
        }

        // Layer 3: 系统设置（MEMORY.md）
        const sysSettings = loadSystemSettings();
        if (sysSettings) {
            messages.push({
                role: "system",
                content: `[系统设置 — .fyuobot/memories/MEMORY.md]\n${sysSettings}`,
            });
        }

        // Layer 4: 核心系统提示词
        messages.push({ role: "system", content: this.systemPrompt });

        // Layer 5: 用户查询
        messages.push({ role: "user", content: query });
        return messages;
    }

    /**
     * 运行完整的 Agent 对话轮次。
     *
     * 委托给 runAgentTask() 执行 LLM 工具调用循环，
     * 通过事件总线发出所有可观察事件。
     *
     * @param query   用户查询文本
     * @param options 可选配置（确认函数等）
     * @returns 最终的响应文本
     */
    async runTask(query: string, options: RunTaskOptions = {}): Promise<string> {
        this._busy = true;
        this._lastActivity = "执行查询";

        const turnId = `turn_${++this._turnCounter}_${Date.now()}`;
        const context = this.buildContext(query);

        try {
            const result = await runAgentTask({
                registry: this.registry,
                bus: this.bus,
                context,
                turnId,
                confirmFn: options.confirmFn ?? (async () => ({ approved: true })),
            });

            this._lastActivity = "✅ 完成";

            // ── 被动全量记录：自动追加到 HISTORY.md ──
            try {
                const { HistoryManager } = await import(
                    "../memory/history-manager.js"
                );
                HistoryManager.instance().saveTurn(
                    "",
                    query.trim(),
                    result.finalContent,
                    result.toolCallRecords.length > 0
                        ? result.toolCallRecords
                        : undefined,
                );

                // 发出历史保存事件
                const historyEvent: HistorySaveEvent = {
                    type: ET.HISTORY_SAVE,
                    turnId,
                    query: query.trim(),
                    response: result.finalContent,
                    toolCallCount: result.toolCallRecords.length,
                };
                this.bus.enqueue(
                    historyEvent,
                    getEventPriority(ET.HISTORY_SAVE),
                );
            } catch (e) {
                console.warn(
                    "[history] 记录失败:",
                    e instanceof Error ? e.message : String(e),
                );
            }

            return result.finalContent;
        } catch (e) {
            this._lastActivity = "❌ 失败";
            throw e;
        } finally {
            this._busy = false;

            // ── 被动触发：自动检测 + 处理超阈值 HISTORY.md ──
            try {
                const { HistoryManager } = await import(
                    "../memory/history-manager.js"
                );
                HistoryManager.instance().checkAndCondense();
            } catch (e) {
                console.warn(
                    "[history] 压缩检查失败:",
                    e instanceof Error ? e.message : String(e),
                );
            }
        }
    }
}
