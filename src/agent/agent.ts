import type OpenAI from "openai";
import { ToolRegistry } from "../tools/basetool.js";
import { MessageQueue } from "./message-queue.js";
import { getEventPriority, AgentEventType as ET } from "./events.js";
import type { HistorySaveEvent } from "./events.js";
import { runAgentTask } from "./agent-task.js";
import { buildOrderedPromptMessages } from "./prompts.js";
import {
    drainPendingResults,
    hasPendingResults,
} from "../tools/sub-agent-tool.js";

export interface AgentConfig {
    name: string;
    systemPrompt: string;
    identity?: string;
}

export interface AgentStatus {
    name: string;
    busy: boolean;
    lastActivity: string;
    toolCount: number;
}

export interface RunTaskOptions {
    confirmFn?: (
        toolName: string,
        args: Record<string, unknown>,
    ) => Promise<{ approved: boolean; feedback?: string }>;
    model?: string;
    context?: OpenAI.Chat.ChatCompletionMessageParam[];
    signal?: AbortSignal;
    turnId?: string;
}

interface PendingRegistry {
    registry: ToolRegistry;
    reason: string;
    preparedAt: number;
}

export class Agent {
    readonly name: string;
    private systemPrompt: string;
    private identity: string | undefined;
    private _registry: ToolRegistry;
    private pendingRegistry: PendingRegistry | undefined;
    readonly bus: MessageQueue;
    private _busy = false;
    private _lastActivity = "已就绪";
    private _turnCounter = 0;

    constructor(
        config: AgentConfig,
        registry: ToolRegistry,
        bus: MessageQueue,
    ) {
        this.name = config.name;
        this.systemPrompt = config.systemPrompt;
        this.identity = config.identity;
        this._registry = registry;
        this.bus = bus;
    }

    get registry(): ToolRegistry {
        return this._registry;
    }

    setPendingRegistry(registry: ToolRegistry, reason: string): void {
        this.pendingRegistry = {
            registry,
            reason,
            preparedAt: Date.now(),
        };
        console.log(
            `[tools] hot update prepared for next turn: ${registry.size} tools (${reason})`,
        );
    }

    clearPendingRegistry(reason: string): void {
        if (!this.pendingRegistry) return;
        this.pendingRegistry = undefined;
        console.log(`[tools] hot update canceled: ${reason}`);
    }

    private async applyPendingRegistry(): Promise<void> {
        const pending = this.pendingRegistry;
        if (!pending) return;

        this.pendingRegistry = undefined;
        const oldRegistry = this._registry;
        this._registry = pending.registry;

        try {
            await oldRegistry.destroyAll();
        } finally {
            await this._registry.initAll(this);
        }

        console.log(
            `[tools] hot update applied: ${this._registry.size} tools (${pending.reason})`,
        );
    }

    get status(): AgentStatus {
        return {
            name: this.name,
            busy: this._busy,
            lastActivity: this._lastActivity,
            toolCount: this.registry.size,
        };
    }

    private collectExtraSystemMessages(): string[] {
        const extraSystemMessages: string[] = [];

        if (hasPendingResults()) {
            const pending = drainPendingResults();
            const resultsText = pending
                .map(
                    (r) =>
                        `[后台子 Agent "${r.subAgentId}" 已完成]\n` +
                        `任务: ${r.task}\n` +
                        `耗时: ${(r.elapsedMs / 1000).toFixed(1)}s\n` +
                        `结果:\n${r.finalContent}`,
                )
                .join("\n\n---\n\n");

            extraSystemMessages.push(
                [
                    "以下是你之前委派的后台子 Agent 的完成结果（已通过 A2A 消息队列主动推送）：",
                    "",
                    resultsText,
                    "",
                    "请根据这些结果继续处理用户的后续请求。",
                ].join("\n"),
            );
        }

        return extraSystemMessages;
    }

    private buildContext(
        query: string,
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        return buildOrderedPromptMessages({
            identity: this.identity,
            systemPrompt: this.systemPrompt,
            extraSystemMessages: this.collectExtraSystemMessages(),
            userQuery: query,
        });
    }

    private injectExtraSystemMessages(
        context: OpenAI.Chat.ChatCompletionMessageParam[],
    ): void {
        const extraSystemMessages = this.collectExtraSystemMessages();
        if (extraSystemMessages.length === 0) return;

        const lastUserIndex = findLastUserMessageIndex(context);
        const insertAt = lastUserIndex >= 0 ? lastUserIndex : context.length;
        context.splice(
            insertAt,
            0,
            ...extraSystemMessages.map((content) => ({
                role: "system" as const,
                content,
            })),
        );
    }

    async runTask(query: string, options: RunTaskOptions = {}): Promise<string> {
        await this.applyPendingRegistry();
        this._busy = true;
        this._lastActivity = "执行查询";

        const turnId = options.turnId ?? `turn_${++this._turnCounter}_${Date.now()}`;
        const context = options.context ?? this.buildContext(query);
        if (options.context) {
            this.injectExtraSystemMessages(context);
        }

        try {
            const result = await runAgentTask({
                registry: this.registry,
                bus: this.bus,
                context,
                turnId,
                confirmFn: options.confirmFn ?? (async () => ({ approved: true })),
                ...(options.model !== undefined ? { model: options.model } : {}),
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
            });

            this._lastActivity = "完成";

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
            this._lastActivity = "失败";
            throw e;
        } finally {
            this._busy = false;

            try {
                const { HistoryManager } = await import(
                    "../memory/history-manager.js"
                );
                await HistoryManager.instance().checkAndCondense();
            } catch (e) {
                console.warn(
                    "[memory] 压缩检查失败:",
                    e instanceof Error ? e.message : String(e),
                );
            }
        }
    }
}

function findLastUserMessageIndex(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") return i;
    }
    return -1;
}
