// .fyuobot/tools/api-server/index.ts
//
// HTTP + SSE API 服务器 —— 事件驱动架构的外部接口。
// 作为 BaseTool，通过 onInit/onDestroy 自动管理生命周期。
//
// 端点：
//   GET  /health          → 健康检查
//   GET  /status          → Agent 状态 + 队列统计
//   POST /query           → 推送查询（JSON 返回 或 SSE 流式）
//   POST /event           → 推送任意 AgentEvent
//   POST /reset           → 重置会话
//
// 架构：
//   外部 HTTP 请求 → 事件入队(agent.bus) → EventLoop 分发 → Agent 被动响应
//   SSE 客户端 ← bus.subscribe() 过滤 turnId ← 事件流

import http from "node:http";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BaseTool, type ToolParam } from "../../../src/tools/basetool.js";
import { AgentEventType as ET } from "../../../src/agent/events.js";
import type {
    AgentEvent,
    AgentMessageEnvelope,
    SubAgentCompleteEvent,
    SubAgentErrorEvent,
    SubAgentProgressEvent,
    SubAgentResultReadyEvent,
    SubAgentStartEvent,
    UserConfirmRequestEvent,
    UserConfirmResponseEvent,
    UserQueryEvent,
    LlmTokenEvent,
    StreamThinkingEvent,
    StreamAnswerEvent,
    ToolProgressEvent,
    ToolExecutionCompleteEvent,
    TaskCompleteEvent,
    TaskErrorEvent,
    TokenStatsUpdateEvent,
} from "../../../src/agent/events.js";
import type { Agent } from "../../../src/agent/agent.js";
import { StreamingSession } from "../../../src/agent/stream.js";
import { EventLoop } from "../../../src/agent/event-loop.js";
import { resolveProjectRoot } from "../../../src/config/agent-paths.js";
import { CommandRegistry } from "../../../src/slash/registry.js";
import {
    SchedulerJobManager,
    type DaemonRunRecord,
} from "../../../src/scheduler/service.js";
import type { SlashCommand } from "../../../src/slash/types.js";
import {
    deleteSubAgent,
    listSubAgents,
    sendMessageToSubAgent,
} from "../../../src/tools/sub-agent-tool.js";
import {
    createA2ARequest,
    createAgentMessageEnvelope,
} from "../../../src/agent/a2a-protocol.js";
import {
    listAgentChanges,
    undoAgentChange,
    undoAgentChangesForTurn,
} from "../../../src/tools/agent-changes/store.js";
import { HistoryManager } from "../../../src/memory/history-manager.js";
import {
    getDefaultModelId,
    listConfiguredModels,
} from "../../../src/llm/model-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig(): { port?: number } {
    const configPath = join(__dirname, "config.json");
    try {
        if (existsSync(configPath)) {
            return JSON.parse(readFileSync(configPath, "utf-8"));
        }
    } catch { /* 回退默认值 */ }
    return {};
}

type AgentKind = "main" | "sub";
type AgentRuntimeState = "idle" | "busy" | "done" | "error";

interface AgentSnapshot {
    id: string;
    name: string;
    kind: AgentKind;
    state: AgentRuntimeState;
    lastActivity: string;
    updatedAt: number;
    task?: string;
    parentTurnId?: string;
    model?: string;
    allowedTools?: string[];
    elapsedMs?: number;
    finalContent?: string;
    error?: string;
    persistent?: boolean;
    deletable?: boolean;
}

interface EventLogEntry {
    id: string;
    ts: number;
    type: string;
    agentId: string;
    agentName: string;
    summary: string;
    payload: Record<string, unknown>;
}

interface StreamClient {
    sse: SSEWriter;
}

interface ConfirmResult {
    approved: boolean;
    feedback?: string;
}

interface PendingConfirmation {
    turnId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    createdAt: number;
    resolve: (result: ConfirmResult) => void;
    reject: (error: Error) => void;
}

interface SchedulerRunCursorShape {
    notifiedRunIds?: string[];
}

interface SchedulerStatusSummary {
    daemonRunning: boolean;
    pendingJobs: number;
    runningJobs: number;
}

// ════════════════════════════════════════════════════════════════
// SSE Writer
// ════════════════════════════════════════════════════════════════

class SSEWriter {
    private res: http.ServerResponse;
    private alive = true;

    constructor(res: http.ServerResponse) {
        this.res = res;
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        res.on("close", () => { this.alive = false; });
    }

    sendEvent(event: string, data: Record<string, unknown>): void {
        if (!this.alive) return;
        this.res.write(`event: ${event}\n`);
        this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    sendComment(text: string): void {
        if (!this.alive) return;
        this.res.write(`: ${text}\n\n`);
    }

    end(): void {
        if (!this.alive) return;
        this.alive = false;
        this.res.end();
    }

    get isAlive(): boolean { return this.alive; }
}

// ════════════════════════════════════════════════════════════════
// APIServerTool
// ════════════════════════════════════════════════════════════════

export class APIServerTool extends BaseTool {
    name = "api-server";
    description =
        "查询 API 服务器运行状态。服务器在 Agent 启动时自动运行。";
    parameters: ToolParam[] = [];

    private server: http.Server | null = null;
    private agent: Agent | null = null;
    private port = 3456;
    private startTime = 0;
    private agentSnapshots = new Map<string, AgentSnapshot>();
    private eventLog: EventLogEntry[] = [];
    private eventCounter = 0;
    private unsubscribeBus: (() => void) | null = null;
    private readonly maxEventLog = 300;
    private defaultSession: StreamingSession | null = null;
    private eventLoop: EventLoop | null = null;
    private commandRegistry: CommandRegistry | null = null;
    private streamClients = new Set<StreamClient>();
    private activeAbortController: AbortController | null = null;
    private activeTurnId: string | null = null;
    private pendingConfirmations = new Map<string, PendingConfirmation>();
    private readonly schedulerDir = join(
        resolveProjectRoot(),
        ".fyuobot",
        "schedules",
    );
    private readonly schedulerRunsPath = join(this.schedulerDir, "runs.json");
    private readonly schedulerCursorPath = join(
        this.schedulerDir,
        "ui-event-cursor.json",
    );
    private schedulerRunPoller: ReturnType<typeof setInterval> | null = null;
    private schedulerCursorLoaded = false;
    private notifiedSchedulerRunIds = new Set<string>();

    // ── 生命周期 ──────────────────────────────────────────

    async onInit(agent: Agent): Promise<void> {
        this.agent = agent;
        this.eventLoop = this.resolveEventLoop(agent.bus);
        this.commandRegistry = this.resolveCommandRegistry();
        const config = loadConfig();
        this.port = config.port ?? 3456;

        this.server = http.createServer((req, res) =>
            this.handleRequest(req, res),
        );

        await new Promise<void>((resolve, reject) => {
            this.server!.listen(this.port, () => {
                this.startTime = Date.now();
                resolve();
            });
            this.server!.on("error", (err: NodeJS.ErrnoException) => {
                if (err.code === "EADDRINUSE") {
                    reject(new Error(`端口 ${this.port} 已被占用`));
                } else {
                    reject(err);
                }
            });
        });

        this.refreshMainAgentSnapshot();
        this.unsubscribeBus = this.agent.bus.subscribe(
            () => true,
            (event: AgentEvent) => {
                this.captureEvent(event);
            },
        );

        if (this.eventLoop) {
            this.defaultSession = new StreamingSession(
                this.agent,
                this.agent.bus,
                this.eventLoop,
            );
        }

        this.startSchedulerReminderBridge();

        console.log(`🌐 [api-server] HTTP 服务已启动 → http://127.0.0.1:${this.port}`);
        console.log(`   POST /query   {"query":"..."}`);
        console.log(`   POST /event   {"type":"...", ...}`);
        console.log(`   GET  /health`);
    }

    async onDestroy(): Promise<void> {
        this.unsubscribeBus?.();
        this.unsubscribeBus = null;
        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server!.close(() => resolve());
            });
            this.server = null;
        }
        this.agent = null;
        this.eventLoop = null;
        this.defaultSession = null;
        this.commandRegistry = null;
        this.streamClients.clear();
        this.clearPendingConfirmations();
        this.activeAbortController = null;
        this.activeTurnId = null;
        this.stopSchedulerReminderBridge();
    }

    // ── 工具调用 ──────────────────────────────────────────

    async execute(_args: Record<string, unknown>): Promise<string> {
        this.refreshMainAgentSnapshot();
        const uptime = this.startTime
            ? Math.round((Date.now() - this.startTime) / 1000)
            : 0;
        const status = this.server?.listening ?? false;
        const busy = this.agent?.status.busy ?? false;
        const queueSize = this.agent?.bus.size ?? 0;

        return [
            `🌐 API 服务器状态:`,
            `  - 运行中: ${status ? "✅ 是" : "❌ 否"}`,
            `  - 端口: ${this.port}`,
            `  - 地址: http://127.0.0.1:${this.port}`,
            `  - 已运行: ${uptime}s`,
            `  - Agent 忙碌: ${busy ? "是" : "否"}`,
            `  - 队列待处理: ${queueSize}`,
            `  - Agent 快照数: ${this.agentSnapshots.size}`,
            `  - 最近事件缓存: ${this.eventLog.length}`,
        ].join("\n");
    }

    // ── HTTP 路由 ─────────────────────────────────────────

    private async handleRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<void> {
        if (req.method === "OPTIONS") {
            this.sendCORS(res);
            return;
        }

        const url = new URL(
            req.url ?? "/",
            `http://${req.headers.host ?? "localhost"}`,
        );
        const path = url.pathname;

        try {
            // GET /health
            if (req.method === "GET" && path === "/health") {
                this.sendJSON(res, 200, {
                    ok: true,
                    uptime: process.uptime(),
                    agentBusy: this.agent?.status.busy ?? false,
                    queueSize: this.agent?.bus.size ?? 0,
                    queueSubscribers: this.agent?.bus.subscriberCount ?? 0,
                });
                return;
            }

            // GET /status
            if (req.method === "GET" && path === "/status") {
                this.refreshMainAgentSnapshot();
                const scheduler = this.getSchedulerStatusSummary();
                this.sendJSON(res, 200, {
                    ...this.agent!.status,
                    queueSize: this.agent!.bus.size,
                    daemonRunning: scheduler.daemonRunning,
                    schedulerPendingJobs: scheduler.pendingJobs,
                    schedulerRunningJobs: scheduler.runningJobs,
                } as unknown as Record<string, unknown>);
                return;
            }

            // GET /agents
            if (req.method === "GET" && path === "/agents") {
                this.refreshMainAgentSnapshot();
                this.sendJSON(res, 200, {
                    agents: this.getSortedAgents(),
                });
                return;
            }

            // GET /models
            if (req.method === "GET" && path === "/models") {
                this.sendJSON(res, 200, {
                    defaultModel: getDefaultModelId(),
                    models: listConfiguredModels(),
                });
                return;
            }

            // GET /snapshot
            if (req.method === "GET" && path === "/snapshot") {
                this.refreshMainAgentSnapshot();
                const scheduler = this.getSchedulerStatusSummary();
                this.sendJSON(res, 200, {
                    agents: this.getSortedAgents(),
                    events: this.eventLog,
                    agentChanges: await listAgentChanges(),
                    daemonRunning: scheduler.daemonRunning,
                    schedulerPendingJobs: scheduler.pendingJobs,
                    schedulerRunningJobs: scheduler.runningJobs,
                });
                return;
            }

            // GET /token-usage
            if (req.method === "GET" && path === "/token-usage") {
                const yearParam = url.searchParams.get("year");
                const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
                const agentId = url.searchParams.get("agentId")?.trim() || undefined;
                const modelId = url.searchParams.get("modelId")?.trim() || undefined;
                const agentKindParam = url.searchParams.get("agentKind")?.trim();
                const agentKind =
                    agentKindParam === "sub" || agentKindParam === "main"
                        ? agentKindParam
                        : undefined;
                const history = HistoryManager.instance();
                const years = history.getTokenUsageYears(sessionId, {
                    ...(agentId ? { agentId } : {}),
                    ...(agentKind ? { agentKind } : {}),
                    ...(modelId ? { modelId } : {}),
                });
                const models = history.getTokenUsageModels(sessionId, {
                    ...(agentId ? { agentId } : {}),
                    ...(agentKind ? { agentKind } : {}),
                });
                const fallbackYear = years[0]?.year ?? new Date().getFullYear();
                const selectedYear = yearParam ? Number.parseInt(yearParam, 10) : fallbackYear;
                this.sendJSON(res, 200, {
                    models,
                    years,
                    selectedYear,
                    heatmapDays: history.getTokenUsageDaysForYear(selectedYear, sessionId, {
                        ...(agentId ? { agentId } : {}),
                        ...(agentKind ? { agentKind } : {}),
                        ...(modelId ? { modelId } : {}),
                    }),
                    trendDays: history.getTokenUsageDays(7, sessionId, {
                        ...(agentId ? { agentId } : {}),
                        ...(agentKind ? { agentKind } : {}),
                        ...(modelId ? { modelId } : {}),
                    }),
                    modelTrendDays: history.getTokenUsageModelTrendDays(7, sessionId, {
                        ...(agentId ? { agentId } : {}),
                        ...(agentKind ? { agentKind } : {}),
                    }),
                });
                return;
            }

            // GET /agent-changes
            if (req.method === "GET" && path === "/agent-changes") {
                this.sendJSON(res, 200, {
                    changes: await listAgentChanges(),
                });
                return;
            }

            // GET /slash/commands
            if (req.method === "GET" && path === "/slash/commands") {
                this.sendJSON(res, 200, {
                    commands: this.getSlashCommands(),
                });
                return;
            }

            // GET /events/stream
            if (req.method === "GET" && path === "/events/stream") {
                this.handleGlobalEventStream(res);
                return;
            }

            // POST /agents/message
            if (req.method === "POST" && path === "/agents/message") {
                const body = await readBody(req, 1024 * 1024);
                let parsed: { agentId?: string; name?: string; message?: string };
                try {
                    parsed = JSON.parse(body);
                } catch {
                    this.sendJSON(res, 400, { error: "无效的 JSON" });
                    return;
                }

                const identifier = (parsed.agentId ?? parsed.name)?.trim();
                const message = parsed.message?.trim();
                if (!identifier || !message) {
                    this.sendJSON(res, 400, { error: "缺少 agentId/name 或 message" });
                    return;
                }

                const target =
                    this.getSortedAgents().find((agent) => agent.id === identifier || agent.name === identifier) ?? null;
                if (!target || target.kind !== "sub") {
                    this.sendJSON(res, 404, { error: "未找到目标子 Agent" });
                    return;
                }

                const turnId = `api_${Date.now()}`;
                try {
                    const result = await this.handleDirectSubAgentQuery(target, message);
                    this.sendJSON(res, 200, {
                        request: createA2ARequest({
                            operation: "send",
                            sourceAgentId: "user",
                            sourceAgentName: "user",
                            targetAgentId: target.id,
                            targetAgentName: target.name,
                            message,
                        }),
                        ...result,
                    });
                } catch (error) {
                    this.sendJSON(res, 500, {
                        error: error instanceof Error ? error.message : String(error),
                        turnId,
                    });
                }
                return;
            }

            // POST /agents/delete
            if (req.method === "POST" && path === "/agents/delete") {
                const body = await readBody(req, 1024 * 1024);
                let parsed: { agentId?: string; name?: string };
                try {
                    parsed = JSON.parse(body);
                } catch {
                    this.sendJSON(res, 400, { error: "无效的 JSON" });
                    return;
                }

                const identifier = (parsed.agentId ?? parsed.name)?.trim();
                if (!identifier) {
                    this.sendJSON(res, 400, { error: "缺少 agentId 或 name" });
                    return;
                }

                const deleted = await deleteSubAgent(identifier);
                if (deleted) {
                    this.agentSnapshots.delete(identifier);
                    for (const [key, value] of this.agentSnapshots.entries()) {
                        if (value.name === identifier) {
                            this.agentSnapshots.delete(key);
                        }
                    }
                }
                this.sendJSON(res, 200, { ok: deleted, deleted });
                return;
            }

            // POST /reset
            if (req.method === "POST" && path === "/reset") {
                this.agent?.bus.clear();
                this.refreshMainAgentSnapshot();
                this.sendJSON(res, 200, { ok: true });
                return;
            }

            // POST /stop
            if (req.method === "POST" && path === "/stop") {
                const stopped = this.stopActiveTask();
                this.sendJSON(res, 200, {
                    ok: stopped,
                    stopped,
                    turnId: this.activeTurnId,
                });
                return;
            }

            // POST /agent-changes/undo
            if (req.method === "POST" && path === "/agent-changes/undo") {
                const body = await readBody(req, 1024 * 1024);
                let parsed: { operationId?: string; turnId?: string };
                try {
                    parsed = JSON.parse(body || "{}");
                } catch {
                    this.sendJSON(res, 400, { error: "无效的 JSON" });
                    return;
                }

                const turnId =
                    typeof parsed.turnId === "string" ? parsed.turnId.trim() : "";
                if (turnId) {
                    const result = await undoAgentChangesForTurn(turnId);
                    this.sendJSON(res, result.ok ? 200 : 409, {
                        ok: result.ok,
                        message: result.message,
                        turnId: result.turnId,
                        revertedEntries: result.revertedEntries,
                        conflictEntry: result.conflictEntry ?? null,
                    });
                    return;
                }

                const result = await undoAgentChange({
                    ...(typeof parsed.operationId === "string" && parsed.operationId.trim()
                        ? { id: parsed.operationId.trim() }
                        : {}),
                });
                this.sendJSON(res, result.ok ? 200 : 409, {
                    ok: result.ok,
                    message: result.message,
                    entry: result.entry ?? null,
                });
                return;
            }

            // POST /query
            if (req.method === "POST" && path === "/query") {
                const body = await readBody(req, 1024 * 1024);
                let parsed: {
                    query?: string;
                    stream?: boolean;
                    sessionId?: string;
                    resetSession?: boolean;
                    sourceAgentId?: string;
                    model?: string;
                };
                try {
                    parsed = JSON.parse(body);
                } catch {
                    this.sendJSON(res, 400, { error: "无效的 JSON" });
                    return;
                }

                if (!parsed.query?.trim()) {
                    this.sendJSON(res, 400, { error: "缺少 query 字段" });
                    return;
                }

                const mentionTarget = this.parseAgentMention(parsed.query.trim());
                const sourceAgent =
                    typeof parsed.sourceAgentId === "string"
                        ? this.agentSnapshots.get(parsed.sourceAgentId) ?? null
                        : null;
                if (mentionTarget) {
                    const result = await this.handleMentionQuery(
                        parsed.query.trim(),
                        mentionTarget,
                        sourceAgent,
                    );
                    this.sendJSON(res, 200, result);
                    return;
                }

                if (sourceAgent?.kind === "sub") {
                    const result = await this.handleDirectSubAgentQuery(
                        sourceAgent,
                        parsed.query.trim(),
                    );
                    this.sendJSON(res, 200, result);
                    return;
                }

                const turnId = `api_${Date.now()}`;
                const useStream = parsed.stream !== false;
                const useSession = parsed.sessionId !== "stateless";

                if (parsed.resetSession) {
                    this.defaultSession?.reset();
                }

                if (useStream) {
                    await this.handleStreamQuery(
                        res,
                        parsed.query.trim(),
                        turnId,
                        useSession,
                        typeof parsed.model === "string" ? parsed.model.trim() : undefined,
                    );
                } else {
                    await this.handleJsonQuery(
                        res,
                        parsed.query.trim(),
                        turnId,
                        useSession,
                        typeof parsed.model === "string" ? parsed.model.trim() : undefined,
                    );
                }
                return;
            }

            // POST /confirm
            if (req.method === "POST" && path === "/confirm") {
                const body = await readBody(req, 1024 * 1024);
                let parsed: {
                    turnId?: string;
                    toolCallId?: string;
                    approved?: boolean;
                    feedback?: string;
                };
                try {
                    parsed = JSON.parse(body);
                } catch {
                    this.sendJSON(res, 400, { error: "无效的 JSON" });
                    return;
                }

                const turnId = parsed.turnId?.trim();
                const toolCallId = parsed.toolCallId?.trim();
                if (!turnId || !toolCallId || typeof parsed.approved !== "boolean") {
                    this.sendJSON(res, 400, {
                        error: "缺少 turnId、toolCallId 或 approved 字段",
                    });
                    return;
                }

                const handled = this.resolvePendingConfirmation(
                    turnId,
                    toolCallId,
                    {
                        approved: parsed.approved,
                        ...(parsed.feedback?.trim()
                            ? { feedback: parsed.feedback.trim() }
                            : {}),
                    },
                );
                if (!handled) {
                    this.sendJSON(res, 404, { error: "未找到待确认的敏感操作" });
                    return;
                }

                this.sendJSON(res, 200, { ok: true });
                return;
            }

            // POST /slash/execute
            if (req.method === "POST" && path === "/slash/execute") {
                const body = await readBody(req, 1024 * 1024);
                let parsed: { input?: string };
                try {
                    parsed = JSON.parse(body);
                } catch {
                    this.sendJSON(res, 400, { error: "无效的 JSON" });
                    return;
                }

                const input = parsed.input?.trim();
                if (!input?.startsWith("/")) {
                    this.sendJSON(res, 400, { error: "缺少 slash 命令" });
                    return;
                }

                const result = await this.executeSlashCommand(input);
                this.sendJSON(res, 200, result);
                return;
            }

            // POST /event
            if (req.method === "POST" && path === "/event") {
                const body = await readBody(req, 1024 * 1024);
                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    this.sendJSON(res, 400, { error: "无效的 JSON" });
                    return;
                }

                if (!parsed.type) {
                    this.sendJSON(res, 400, { error: "缺少 type 字段" });
                    return;
                }

                this.agent!.bus.enqueue(parsed as unknown as AgentEvent);
                console.log(`[api-server] 📨 事件入队: type=${parsed.type}`);
                this.sendJSON(res, 200, {
                    ok: true,
                    eventType: parsed.type,
                    queueSize: this.agent!.bus.size,
                });
                return;
            }

            // 404
            this.sendJSON(res, 404, { error: "Not found" });
        } catch (err) {
            if (!res.headersSent) {
                this.sendJSON(res, 500, {
                    error: err instanceof Error ? err.message : "服务器内部错误",
                });
            }
        }
    }

    private refreshMainAgentSnapshot(): void {
        if (!this.agent) return;
        const status = this.agent.status;
        const now = Date.now();
        const existing = this.agentSnapshots.get(status.name);
        this.agentSnapshots.set(status.name, {
            id: status.name,
            name: status.name,
            kind: "main",
            state: status.busy ? "busy" : "idle",
            lastActivity: status.lastActivity,
            updatedAt: now,
            persistent: true,
            deletable: false,
            ...(existing?.task !== undefined ? { task: existing.task } : {}),
            ...(existing?.parentTurnId !== undefined
                ? { parentTurnId: existing.parentTurnId }
                : {}),
            ...(existing?.elapsedMs !== undefined
                ? { elapsedMs: existing.elapsedMs }
                : {}),
            ...(existing?.finalContent !== undefined
                ? { finalContent: existing.finalContent }
                : {}),
            ...(existing?.error !== undefined ? { error: existing.error } : {}),
        });
    }

    private captureEvent(event: AgentEvent): void {
        this.refreshMainAgentSnapshot();

        if (this.isSubAgentEvent(event)) {
            this.updateSubAgentSnapshot(event);
        } else {
            this.updateMainAgentActivity(event);
        }

        const entry = this.toEventLogEntry(event);
        this.appendEventLog(entry);
        if (this.eventLog.length > this.maxEventLog) {
            this.eventLog.splice(0, this.eventLog.length - this.maxEventLog);
        }
        this.broadcastSnapshotEvent(entry);
    }

    private appendEventLog(entry: EventLogEntry): void {
        if (entry.type === ET.LLM_TOKEN) {
            return;
        }

        const turnId = this.extractTurnId(entry.payload);
        if (
            turnId &&
            (entry.type === ET.STREAM_ANSWER || entry.type === ET.STREAM_THINKING)
        ) {
            for (let i = this.eventLog.length - 1; i >= 0; i -= 1) {
                const existing = this.eventLog[i]!;
                if (existing.type !== entry.type) continue;
                const existingTurnId = this.extractTurnId(existing.payload);
                if (existingTurnId !== turnId) continue;
                this.eventLog[i] = entry;
                return;
            }
        }

        this.eventLog.push(entry);
    }

    private updateMainAgentActivity(event: AgentEvent): void {
        if (!this.agent) return;
        const main = this.agentSnapshots.get(this.agent.status.name);
        if (!main) return;

        if (
            event.type === ET.LLM_TOKEN ||
            event.type === ET.TOKEN_STATS_UPDATE
        ) {
            return;
        }

        const summary = this.summarizeEvent(event);
        main.lastActivity = summary;
        main.updatedAt = Date.now();
            if (event.type === ET.TASK_COMPLETE) {
                main.state = "idle";
                main.finalContent = (event as TaskCompleteEvent).finalContent;
                this.clearActiveAbortController(this.extractTurnId(event as unknown as Record<string, unknown>) ?? undefined);
            } else if (event.type === ET.TASK_ERROR) {
                main.state = "error";
                main.error = (event as TaskErrorEvent).error;
                this.clearActiveAbortController(this.extractTurnId(event as unknown as Record<string, unknown>) ?? undefined);
            } else if (
                event.type === ET.USER_QUERY ||
                event.type === ET.TASK_START ||
            event.type === ET.LLM_REQUEST_START ||
            event.type === ET.TOOL_EXECUTION_START
        ) {
            main.state = "busy";
        } else if (event.type === ET.AGENT_READY) {
            main.state = "idle";
        }
        this.agentSnapshots.set(main.id, main);
    }

    private updateSubAgentSnapshot(event: SubAgentEvent): void {
        const subAgentId = event.subAgentId;
        const current = this.agentSnapshots.get(subAgentId);
        const now = Date.now();
        const next: AgentSnapshot = {
            id: subAgentId,
            name: event.subAgentName ?? current?.name ?? subAgentId,
            kind: "sub",
            state: current?.state ?? "busy",
            lastActivity: this.summarizeEvent(event),
            updatedAt: now,
            task: event.task,
            parentTurnId: event.parentTurnId,
            persistent: true,
            deletable: true,
            ...(current?.model !== undefined ? { model: current.model } : {}),
            ...(current?.allowedTools !== undefined
                ? { allowedTools: current.allowedTools }
                : {}),
            ...(current?.elapsedMs !== undefined
                ? { elapsedMs: current.elapsedMs }
                : {}),
            ...(current?.finalContent !== undefined
                ? { finalContent: current.finalContent }
                : {}),
            ...(current?.error !== undefined ? { error: current.error } : {}),
        };

        switch (event.type) {
            case ET.SUB_AGENT_START: {
                const start = event as SubAgentStartEvent;
                next.state = "busy";
                next.model = start.model;
                next.allowedTools = start.allowedTools;
                break;
            }
            case ET.SUB_AGENT_PROGRESS: {
                next.state = "busy";
                next.lastActivity = (event as SubAgentProgressEvent).message;
                break;
            }
            case ET.SUB_AGENT_COMPLETE: {
                const complete = event as SubAgentCompleteEvent;
                next.state = "done";
                next.finalContent = complete.finalContent;
                next.elapsedMs = complete.elapsedMs;
                break;
            }
            case ET.SUB_AGENT_RESULT_READY: {
                const ready = event as SubAgentResultReadyEvent;
                next.state = "done";
                next.finalContent = ready.finalContent;
                next.elapsedMs = ready.elapsedMs;
                break;
            }
            case ET.SUB_AGENT_ERROR: {
                const error = event as SubAgentErrorEvent;
                next.state = "error";
                next.error = error.error;
                break;
            }
        }

        this.agentSnapshots.set(subAgentId, next);
    }

    private handleGlobalEventStream(res: http.ServerResponse): void {
        const sse = new SSEWriter(res);
        this.refreshMainAgentSnapshot();
        const client: StreamClient = { sse };
        this.streamClients.add(client);

        sse.sendEvent("snapshot", {
            agents: this.getSortedAgents(),
            events: this.eventLog,
            daemonRunning: this.isSchedulerDaemonRunning(),
        });

        const heartbeat = setInterval(() => {
            if (sse.isAlive) sse.sendComment("ping");
            else clearInterval(heartbeat);
        }, 15_000);

        res.on("close", () => {
            clearInterval(heartbeat);
            this.streamClients.delete(client);
        });
    }

    private resolveEventLoop(bus: Agent["bus"]): EventLoop | null {
        const maybeLoop = (globalThis as Record<string, unknown>).__FYUO_EVENT_LOOP__;
        if (maybeLoop instanceof EventLoop) {
            return maybeLoop;
        }
        const maybeBusLoop = (bus as unknown as { __loop?: unknown }).__loop;
        if (maybeBusLoop instanceof EventLoop) {
            return maybeBusLoop;
        }
        return null;
    }

    private resolveCommandRegistry(): CommandRegistry | null {
        const maybeRegistry = (globalThis as Record<string, unknown>).__FYUO_COMMAND_REGISTRY__;
        if (maybeRegistry instanceof CommandRegistry) {
            return maybeRegistry;
        }
        return null;
    }

    private getSortedAgents(): AgentSnapshot[] {
        for (const subAgent of listSubAgents()) {
            if (!this.agentSnapshots.has(subAgent.subAgentId)) {
                this.agentSnapshots.set(subAgent.subAgentId, {
                    id: subAgent.subAgentId,
                    name: subAgent.subAgentName,
                    kind: "sub",
                    state:
                        subAgent.status === "running"
                            ? "busy"
                            : subAgent.status === "failed"
                              ? "error"
                              : "done",
                    lastActivity: subAgent.task,
                    updatedAt: subAgent.startedAt,
                    task: subAgent.task,
                    allowedTools: subAgent.allowedTools,
                    persistent: subAgent.persistent,
                    deletable: true,
                    ...(subAgent.model !== undefined ? { model: subAgent.model } : {}),
                });
            } else {
                const existing = this.agentSnapshots.get(subAgent.subAgentId)!;
                if (subAgent.model !== undefined) {
                    existing.model = subAgent.model;
                }
                existing.allowedTools = subAgent.allowedTools;
                existing.persistent = subAgent.persistent;
                existing.deletable = true;
            }
        }

        return [...this.agentSnapshots.values()].sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "main" ? -1 : 1;
            return b.updatedAt - a.updatedAt;
        });
    }

    private getSlashCommands(): Array<{
        name: string;
        description: string;
        aliases: string[];
    }> {
        return (this.commandRegistry?.getAll() ?? []).map((cmd: SlashCommand) => ({
            name: cmd.name,
            description: cmd.description,
            aliases: cmd.aliases ?? [],
        }));
    }

    private toEventLogEntry(event: AgentEvent): EventLogEntry {
        const payload = event as unknown as Record<string, unknown>;
        const subAgentId =
            "subAgentId" in payload && typeof payload.subAgentId === "string"
                ? payload.subAgentId
                : null;
        const agentId = subAgentId ?? (this.agent?.status.name ?? "main");
        const agentName =
            ("subAgentName" in payload && typeof payload.subAgentName === "string"
                ? payload.subAgentName
                : null) ?? agentId;

        return {
            id: `evt_${++this.eventCounter}_${Date.now()}`,
            ts: Date.now(),
            type: event.type,
            agentId,
            agentName,
            summary: this.summarizeEvent(event),
            payload,
        };
    }

    private extractTurnId(payload: Record<string, unknown>): string | null {
        if (typeof payload.turnId === "string") {
            return payload.turnId;
        }
        if (typeof payload.parentTurnId === "string") {
            return payload.parentTurnId;
        }
        return null;
    }

    private createConfirmKey(turnId: string, toolCallId: string): string {
        return `${turnId}:${toolCallId}`;
    }

    private createConfirmHandler(
        turnId: string,
        signal?: AbortSignal,
    ): (
        toolCallId: string,
        toolName: string,
        args: Record<string, unknown>,
    ) => Promise<ConfirmResult> {
        return (toolCallId, toolName, args) =>
            new Promise<ConfirmResult>((resolve, reject) => {
                const key = this.createConfirmKey(turnId, toolCallId);
                const abortListener = () => {
                    this.pendingConfirmations.delete(key);
                    reject(new Error("用户取消了当前操作"));
                };

                if (signal?.aborted) {
                    reject(new Error("用户取消了当前操作"));
                    return;
                }

                this.pendingConfirmations.set(key, {
                    turnId,
                    toolCallId,
                    toolName,
                    args,
                    createdAt: Date.now(),
                    resolve: (result) => {
                        signal?.removeEventListener("abort", abortListener);
                        resolve(result);
                    },
                    reject: (error) => {
                        signal?.removeEventListener("abort", abortListener);
                        reject(error);
                    },
                });

                signal?.addEventListener("abort", abortListener, { once: true });
            });
    }

    private resolvePendingConfirmation(
        turnId: string,
        toolCallId: string,
        result: ConfirmResult,
    ): boolean {
        const key = this.createConfirmKey(turnId, toolCallId);
        const pending = this.pendingConfirmations.get(key);
        if (!pending) {
            return false;
        }

        this.pendingConfirmations.delete(key);
        const responseEvent: UserConfirmResponseEvent = {
            type: ET.USER_CONFIRM_RESPONSE,
            turnId,
            toolCallId,
            toolName: pending.toolName,
            approved: result.approved,
            ...(result.feedback ? { feedback: result.feedback } : {}),
        };
        this.captureEvent(responseEvent);
        pending.resolve(result);
        return true;
    }

    private rejectPendingConfirmationsForTurn(turnId: string, reason: string): void {
        for (const [key, pending] of this.pendingConfirmations.entries()) {
            if (pending.turnId !== turnId) continue;
            this.pendingConfirmations.delete(key);
            pending.reject(new Error(reason));
        }
    }

    private clearPendingConfirmations(): void {
        for (const pending of this.pendingConfirmations.values()) {
            pending.reject(new Error("API server is shutting down"));
        }
        this.pendingConfirmations.clear();
    }

    private startSchedulerReminderBridge(): void {
        this.scanSchedulerRuns();
        if (this.schedulerRunPoller) {
            clearInterval(this.schedulerRunPoller);
        }
        this.schedulerRunPoller = setInterval(() => {
            this.scanSchedulerRuns();
        }, 2_000);
    }

    private stopSchedulerReminderBridge(): void {
        if (this.schedulerRunPoller) {
            clearInterval(this.schedulerRunPoller);
            this.schedulerRunPoller = null;
        }
    }

    private isSchedulerDaemonRunning(): boolean {
        return existsSync(join(this.schedulerDir, "daemon.lock"));
    }

    private getSchedulerStatusSummary(): SchedulerStatusSummary {
        try {
            const manager = new SchedulerJobManager();
            const jobs = manager.list().filter((job) => job.enabled);
            return {
                daemonRunning: this.isSchedulerDaemonRunning(),
                pendingJobs: jobs.filter((job) => job.nextRunAt !== null).length,
                runningJobs: jobs.filter((job) => job.activeRuns > 0).length,
            };
        } catch {
            return {
                daemonRunning: this.isSchedulerDaemonRunning(),
                pendingJobs: 0,
                runningJobs: 0,
            };
        }
    }

    private scanSchedulerRuns(): void {
        const runs = this.readSchedulerRuns();
        if (!this.schedulerCursorLoaded) {
            const hasCursor = this.loadSchedulerRunCursor();
            this.schedulerCursorLoaded = true;
            if (!hasCursor) {
                for (const run of runs) {
                    if (this.isTerminalSchedulerRun(run)) {
                        this.notifiedSchedulerRunIds.add(run.runId);
                    }
                }
                this.saveSchedulerRunCursor();
                return;
            }

        }

        const unseenRuns = runs
            .filter(
                (run) =>
                    this.isTerminalSchedulerRun(run) &&
                    !this.notifiedSchedulerRunIds.has(run.runId),
            )
            .sort(
                (a, b) =>
                    (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt),
            );

        if (unseenRuns.length === 0) {
            return;
        }

        for (const run of unseenRuns) {
            this.emitSchedulerRunEntry(run);
            this.notifiedSchedulerRunIds.add(run.runId);
        }

        this.saveSchedulerRunCursor();
    }

    private readSchedulerRuns(): DaemonRunRecord[] {
        if (!existsSync(this.schedulerRunsPath)) {
            return [];
        }

        try {
            const raw = JSON.parse(
                readFileSync(this.schedulerRunsPath, "utf-8"),
            ) as { runs?: DaemonRunRecord[] };
            return Array.isArray(raw.runs) ? raw.runs : [];
        } catch (error) {
            console.warn(
                "[api-server] 读取定时任务运行记录失败:",
                error instanceof Error ? error.message : String(error),
            );
            return [];
        }
    }

    private loadSchedulerRunCursor(): boolean {
        if (!existsSync(this.schedulerCursorPath)) {
            return false;
        }

        try {
            const raw = JSON.parse(
                readFileSync(this.schedulerCursorPath, "utf-8"),
            ) as SchedulerRunCursorShape;
            this.notifiedSchedulerRunIds = new Set(raw.notifiedRunIds ?? []);
            return true;
        } catch (error) {
            console.warn(
                "[api-server] 读取定时任务提醒游标失败，已重建:",
                error instanceof Error ? error.message : String(error),
            );
            this.notifiedSchedulerRunIds.clear();
            return false;
        }
    }

    private saveSchedulerRunCursor(): void {
        while (this.notifiedSchedulerRunIds.size > 400) {
            const first = this.notifiedSchedulerRunIds.values().next();
            if (first.done) break;
            this.notifiedSchedulerRunIds.delete(first.value);
        }

        mkdirSync(this.schedulerDir, { recursive: true });
        writeFileSync(
            this.schedulerCursorPath,
            `${JSON.stringify(
                {
                    notifiedRunIds: [...this.notifiedSchedulerRunIds],
                } satisfies SchedulerRunCursorShape,
                null,
                2,
            )}\n`,
            "utf-8",
        );
    }

    private isTerminalSchedulerRun(run: DaemonRunRecord): boolean {
        return run.status === "completed" || run.status === "failed";
    }

    private emitSchedulerRunEntry(run: DaemonRunRecord): void {
        if (!this.agent) return;

        this.refreshMainAgentSnapshot();
        const mainAgentId = this.agent.status.name;
        const completed = run.status === "completed";
        const summary = completed
            ? `定时任务 "${run.jobName}" 已完成`
            : `定时任务 "${run.jobName}" 执行失败`;
        const entry = this.createSyntheticEntry(
            completed ? "schedule:run_complete" : "schedule:run_error",
            mainAgentId,
            mainAgentId,
            summary,
            {
                turnId: `schedule_${run.runId}`,
                runId: run.runId,
                jobId: run.jobId,
                jobName: run.jobName,
                trigger: run.trigger,
                startedAt: run.startedAt,
                finishedAt: run.finishedAt,
                finalContent: run.finalContent,
                error: run.error,
            },
        );

        const snapshot = this.agentSnapshots.get(mainAgentId);
        if (snapshot) {
            snapshot.lastActivity = summary;
            snapshot.updatedAt = Date.now();
            this.agentSnapshots.set(snapshot.id, snapshot);
        }

        this.pushSyntheticEntry(entry);
    }

    private broadcastSnapshotEvent(entry: EventLogEntry): void {
        for (const client of this.streamClients) {
            if (!client.sse.isAlive) continue;
            client.sse.sendEvent("event", { entry });
            const scheduler = this.getSchedulerStatusSummary();
            client.sse.sendEvent("agents", {
                agents: this.getSortedAgents(),
                daemonRunning: scheduler.daemonRunning,
                schedulerPendingJobs: scheduler.pendingJobs,
                schedulerRunningJobs: scheduler.runningJobs,
            });
        }
    }

    private async executeSlashCommand(input: string): Promise<Record<string, unknown>> {
        const trimmed = input.trim();
        const parts = trimmed.slice(1).split(/\s+/);
        const name = parts[0] ?? "";
        const args = parts.slice(1).join(" ");

        if (!this.commandRegistry) {
            return { ok: false, error: "slash 命令系统未就绪" };
        }

        const result = await this.commandRegistry.execute(name, {
            args,
            ui: {
                clearHistory: () => {
                    this.eventLog = [];
                    for (const client of this.streamClients) {
                        if (!client.sse.isAlive) continue;
                        client.sse.sendEvent("snapshot", {
                            agents: this.getSortedAgents(),
                            events: this.eventLog,
                        });
                    }
                },
                addSystemMessage: (msg: string) => {
                    const entry: EventLogEntry = {
                        id: `evt_${++this.eventCounter}_${Date.now()}`,
                        ts: Date.now(),
                        type: "system:message",
                        agentId: this.agent?.status.name ?? "main",
                        agentName: this.agent?.status.name ?? "main",
                        summary: msg,
                        payload: {
                            turnId: `system_${Date.now()}`,
                            message: msg,
                        },
                    };
                    this.appendEventLog(entry);
                    this.broadcastSnapshotEvent(entry);
                },
                newConversation: () => {
                    this.defaultSession?.reset();
                },
                exitApp: (reason?: string) => {
                    (
                        globalThis as {
                            __FYUO_REQUEST_EXIT__?: (reason?: string) => void;
                        }
                    ).__FYUO_REQUEST_EXIT__?.(reason);
                },
            },
        });

        return {
            ok: result.type !== "error",
            type: result.type,
            ...(result.type === "error" ? { error: result.message } : {}),
            ...(result.type === "output" ? { text: result.text } : {}),
        };
    }

    private summarizeEvent(event: AgentEvent): string {
        switch (event.type) {
            case ET.USER_QUERY:
                return `收到查询: ${(event as UserQueryEvent).query}`;
            case ET.USER_CONFIRM_REQUEST: {
                const confirm = event as UserConfirmRequestEvent;
                return `等待确认: ${confirm.toolName}`;
            }
            case ET.USER_CONFIRM_RESPONSE: {
                const confirm = event as UserConfirmResponseEvent;
                return confirm.approved
                    ? `已批准敏感操作: ${confirm.toolName}`
                    : `已拒绝敏感操作: ${confirm.toolName}`;
            }
            case ET.LLM_REQUEST_START:
                return "开始请求模型";
            case ET.LLM_TOKEN:
                return `输出 token: ${(event as LlmTokenEvent).token}`;
            case ET.STREAM_THINKING:
                return `思考: ${(event as StreamThinkingEvent).text}`;
            case ET.STREAM_ANSWER:
                return `回答: ${(event as StreamAnswerEvent).text}`;
            case ET.TOOL_PROGRESS: {
                const tool = event as ToolProgressEvent;
                return `${tool.toolName}: ${tool.progress}`;
            }
            case ET.TOOL_EXECUTION_COMPLETE: {
                const tool = event as ToolExecutionCompleteEvent;
                return `${tool.toolName}: ${
                    tool.hideOutput
                        ? "输出已隐藏"
                        : (tool.summary ?? "执行完成")
                }`;
            }
            case ET.TASK_COMPLETE:
                return "任务完成";
            case ET.TASK_ERROR:
                return `任务失败: ${(event as TaskErrorEvent).error}`;
            case ET.SUB_AGENT_START: {
                const sub = event as SubAgentStartEvent;
                return `子 Agent 启动: ${sub.task}`;
            }
            case ET.SUB_AGENT_PROGRESS:
                return `子 Agent 进度: ${(event as SubAgentProgressEvent).message}`;
            case ET.SUB_AGENT_COMPLETE:
                return "子 Agent 完成";
            case ET.SUB_AGENT_RESULT_READY:
                return "子 Agent 结果待领取";
            case ET.SUB_AGENT_ERROR:
                return `子 Agent 失败: ${(event as SubAgentErrorEvent).error}`;
            default:
                return event.type;
        }
    }

    private isSubAgentEvent(event: AgentEvent): event is SubAgentEvent {
        return (
            event.type === ET.SUB_AGENT_START ||
            event.type === ET.SUB_AGENT_PROGRESS ||
            event.type === ET.SUB_AGENT_COMPLETE ||
            event.type === ET.SUB_AGENT_ERROR ||
            event.type === ET.SUB_AGENT_RESULT_READY
        );
    }

    // ── 流式查询 (SSE) ────────────────────────────────────

    private async handleStreamQuery(
        res: http.ServerResponse,
        query: string,
        turnId: string,
        useSession: boolean,
        model?: string,
    ): Promise<void> {
        const sse = new SSEWriter(res);
        const bus = this.agent!.bus;
        const abortController = useSession ? this.createActiveAbortController(turnId) : null;

        // 订阅本 turn 的所有事件 → 转发为 SSE
        const unsub = bus.subscribe(
            () => true,
            (event: AgentEvent) => {
            // 只处理本 turn 的事件
            if (!("turnId" in event) || (event as any).turnId !== turnId) return;

            switch (event.type) {
                case ET.LLM_TOKEN:
                    sse.sendEvent("token", {
                        token: (event as LlmTokenEvent).token,
                        cumulative: (event as LlmTokenEvent).cumulativeText,
                    });
                    break;
                case ET.STREAM_THINKING:
                    sse.sendEvent("thinking", {
                        content: (event as StreamThinkingEvent).text,
                    });
                    break;
                case ET.STREAM_ANSWER:
                    sse.sendEvent("answer", {
                        content: (event as StreamAnswerEvent).text,
                    });
                    break;
                case ET.USER_CONFIRM_REQUEST: {
                    const confirm = event as UserConfirmRequestEvent;
                    sse.sendEvent("confirm_required", {
                        turnId: confirm.turnId,
                        toolCallId: confirm.toolCallId,
                        toolName: confirm.toolName,
                        args: confirm.args,
                        timestamp: confirm.timestamp,
                    });
                    break;
                }
                case ET.TOOL_PROGRESS:
                    sse.sendEvent("tool_progress", {
                        name: (event as ToolProgressEvent).toolName,
                        progress: (event as ToolProgressEvent).progress,
                    });
                    break;
                case ET.TOOL_EXECUTION_COMPLETE: {
                    const te = event as ToolExecutionCompleteEvent;
                    sse.sendEvent("tool_result", {
                        name: te.toolName,
                        summary: te.hideOutput
                            ? `[${te.toolName}] 输出已隐藏（由工具配置控制）`
                            : te.summary,
                        result: te.result,
                        artifacts: te.artifacts ?? [],
                        hideOutput: te.hideOutput ?? false,
                        error: te.error ?? null,
                    });
                    break;
                }
                case ET.TOKEN_STATS_UPDATE:
                    sse.sendEvent("stats", {
                        ...(event as TokenStatsUpdateEvent).stats,
                    } as unknown as Record<string, unknown>);
                    break;
                case ET.TASK_COMPLETE: {
                    const tc = event as TaskCompleteEvent;
                    this.clearActiveAbortController(turnId);
                    sse.sendEvent("done", {
                        finalContent: tc.finalContent,
                        totalToolCalls: tc.totalToolCalls,
                        totalLlmCalls: tc.totalLlmCalls,
                        elapsedMs: tc.elapsedMs,
                    });
                    sse.end();
                    unsub();
                    break;
                }
                case ET.TASK_ERROR: {
                    this.clearActiveAbortController(turnId);
                    sse.sendEvent("error", {
                        message: (event as TaskErrorEvent).error,
                    });
                    sse.end();
                    unsub();
                    break;
                }
            }
        });

        // 心跳（防止连接空闲断开）
        const heartbeat = setInterval(() => {
            if (sse.isAlive) sse.sendComment("ping");
            else clearInterval(heartbeat);
        }, 15_000);

        // SSE 关闭时清理
        res.on("close", () => {
            clearInterval(heartbeat);
            unsub();
        });

        // 入队查询事件
        const userEvent: UserQueryEvent = {
            type: ET.USER_QUERY,
            turnId,
            query,
            timestamp: Date.now(),
        };
            if (useSession && this.defaultSession) {
                this.captureManualQueryEvent(userEvent);
                void this.defaultSession
                    .submitQuery(
                        query,
                        this.createConfirmHandler(
                            turnId,
                            abortController?.signal,
                        ),
                        {
                        turnId,
                        ...(model ? { model } : {}),
                        ...(abortController ? { signal: abortController.signal } : {}),
                        },
                    )
                    .catch((error) => {
                        this.clearActiveAbortController(turnId);
                        console.warn(
                            "[api-server] session stream query failed:",
                            error instanceof Error ? error.message : String(error),
                    );
                });
        } else {
            bus.enqueue(userEvent);
        }
    }

    // ── 非流式查询 (JSON) ─────────────────────────────────

    private async handleJsonQuery(
        res: http.ServerResponse,
        query: string,
        turnId: string,
        useSession: boolean,
        model?: string,
    ): Promise<void> {
        const bus = this.agent!.bus;
        const abortController = useSession ? this.createActiveAbortController(turnId) : null;
        const events: Array<{ type: string; [key: string]: unknown }> = [];
        let finalContent = "";
        let resolved = false;

        await new Promise<void>((resolve) => {
            const unsub = bus.subscribe(
                () => true,
                (event: AgentEvent) => {
                if (!("turnId" in event) || (event as any).turnId !== turnId) return;

                switch (event.type) {
                    case ET.STREAM_THINKING:
                        events.push({
                            type: "thinking",
                            content: (event as StreamThinkingEvent).text,
                        });
                        break;
                    case ET.STREAM_ANSWER:
                        events.push({
                            type: "answer",
                            content: (event as StreamAnswerEvent).text,
                        });
                        break;
                    case ET.USER_CONFIRM_REQUEST: {
                        const confirm = event as UserConfirmRequestEvent;
                        events.push({
                            type: "confirm_required",
                            turnId: confirm.turnId,
                            toolCallId: confirm.toolCallId,
                            toolName: confirm.toolName,
                            args: confirm.args,
                            timestamp: confirm.timestamp,
                        });
                        break;
                    }
                    case ET.TOOL_EXECUTION_COMPLETE: {
                        const te = event as ToolExecutionCompleteEvent;
                        events.push({
                            type: "tool_result",
                            name: te.toolName,
                            summary: te.hideOutput
                                ? `[${te.toolName}] 输出已隐藏（由工具配置控制）`
                                : te.summary,
                            result: te.result,
                            artifacts: te.artifacts ?? [],
                            hideOutput: te.hideOutput ?? false,
                        });
                        break;
                    }
                    case ET.TASK_COMPLETE:
                        this.clearActiveAbortController(turnId);
                        finalContent = (event as TaskCompleteEvent).finalContent;
                        if (!resolved) { resolved = true; unsub(); resolve(); }
                        break;
                    case ET.TASK_ERROR:
                        this.clearActiveAbortController(turnId);
                        events.push({
                            type: "error",
                            message: (event as TaskErrorEvent).error,
                        });
                        if (!resolved) { resolved = true; unsub(); resolve(); }
                        break;
                }
            });

            // 超时保护 (5 分钟)
            setTimeout(() => {
                this.clearActiveAbortController(turnId);
                if (!resolved) { resolved = true; unsub(); resolve(); }
            }, 300_000);

            // 入队
            const userEvent: UserQueryEvent = {
                type: ET.USER_QUERY,
                turnId,
                query,
                timestamp: Date.now(),
            };
            if (useSession && this.defaultSession) {
                this.captureManualQueryEvent(userEvent);
                void this.defaultSession
                    .submitQuery(
                        query,
                        this.createConfirmHandler(
                            turnId,
                            abortController?.signal,
                        ),
                        {
                        turnId,
                        ...(model ? { model } : {}),
                        ...(abortController ? { signal: abortController.signal } : {}),
                        },
                    )
                    .catch((error) => {
                        this.clearActiveAbortController(turnId);
                        console.warn(
                            "[api-server] session json query failed:",
                            error instanceof Error ? error.message : String(error),
                        );
                    });
            } else {
                bus.enqueue(userEvent);
            }
        });

        this.sendJSON(res, 200, { content: finalContent, events, turnId });
    }

    private captureManualQueryEvent(event: UserQueryEvent): void {
        this.captureEvent(event);
    }

    private createSyntheticEntry(
        type: string,
        agentId: string,
        agentName: string,
        summary: string,
        payload: Record<string, unknown>,
    ): EventLogEntry {
        return {
            id: `evt_${++this.eventCounter}_${Date.now()}`,
            ts: Date.now(),
            type,
            agentId,
            agentName,
            summary,
            payload,
        };
    }

    private pushSyntheticEntry(entry: EventLogEntry): void {
        this.appendEventLog(entry);
        this.broadcastSnapshotEvent(entry);
    }

    private async handleDirectSubAgentQuery(
        sourceAgent: AgentSnapshot,
        query: string,
    ): Promise<Record<string, unknown>> {
        const turnId = `api_${Date.now()}`;
        try {
            const result = await sendMessageToSubAgent(sourceAgent.name, query, {
                parentTurnId: turnId,
                sourceAgentId: "user",
                sourceAgentName: "user",
                channel: "direct",
            });
            return {
                ok: true,
                turnId,
                target: sourceAgent.name,
                content: result.finalContent,
            };
        } catch (error) {
            return {
                ok: false,
                turnId,
                target: sourceAgent.name,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private createActiveAbortController(turnId: string): AbortController {
        this.stopActiveTask();
        const controller = new AbortController();
        this.activeAbortController = controller;
        this.activeTurnId = turnId;
        return controller;
    }

    private clearActiveAbortController(turnId?: string): void {
        if (turnId && this.activeTurnId && this.activeTurnId !== turnId) {
            return;
        }
        this.activeAbortController = null;
        this.activeTurnId = null;
    }

    private stopActiveTask(): boolean {
        const turnId = this.activeTurnId;
        if (this.activeTurnId) {
            this.rejectPendingConfirmationsForTurn(
                this.activeTurnId,
                "用户取消了当前操作",
            );
        }
        const controller = this.activeAbortController;
        if (!controller || controller.signal.aborted) {
            this.activeAbortController = null;
            this.activeTurnId = null;
            return false;
        }
        controller.abort();
        this.activeAbortController = null;
        this.activeTurnId = null;
        if (turnId) {
            this.captureEvent({
                type: ET.TASK_ERROR,
                turnId,
                error: "用户已停止当前对话",
                elapsedMs: 0,
            });
        }
        return true;
    }

    private parseAgentMention(query: string): { name: string; message: string } | null {
        const match = query.match(/^@([^\s]+)\s+([\s\S]+)$/);
        if (!match) return null;

        const [, rawName, rawMessage] = match;
        if (rawName === undefined || rawMessage === undefined) return null;
        const name = rawName;
        const message = rawMessage;
        const trimmedMessage = message.trim();
        if (!trimmedMessage) return null;

        return {
            name,
            message: trimmedMessage,
        };
    }

    private async handleMentionQuery(
        originalQuery: string,
        mention: { name: string; message: string },
        sourceAgent: AgentSnapshot | null = null,
    ): Promise<Record<string, unknown>> {
        const turnId = `api_${Date.now()}`;
        const targetAgent = this.getSortedAgents().find(
            (agent) => agent.kind === "sub" && agent.name === mention.name,
        );

        if (!sourceAgent) {
            const userEvent: UserQueryEvent = {
                type: ET.USER_QUERY,
                turnId,
                query: originalQuery,
                timestamp: Date.now(),
            };
            this.captureManualQueryEvent(userEvent);
        }

        try {
            const result = await sendMessageToSubAgent(mention.name, mention.message, {
                parentTurnId: turnId,
                ...(sourceAgent
                    ? {
                        sourceAgentId: sourceAgent.id,
                        sourceAgentName: sourceAgent.name,
                        channel: "a2a" as const,
                    }
                    : {
                        sourceAgentId: "user",
                        sourceAgentName: "user",
                        channel: "direct" as const,
                    }),
            });
            if (!sourceAgent) {
                this.captureEvent({
                    type: ET.STREAM_ANSWER,
                    turnId,
                    text: result.finalContent,
                });
                this.captureEvent({
                    type: ET.TASK_COMPLETE,
                    turnId,
                    finalContent: result.finalContent,
                    totalToolCalls: result.totalToolCalls,
                    totalLlmCalls: result.totalLlmCalls,
                    elapsedMs: result.elapsedMs,
                });
            }
            return {
                ok: true,
                turnId,
                target: mention.name,
                content: result.finalContent,
            };
        } catch (error) {
            this.captureEvent({
                type: ET.TASK_ERROR,
                turnId,
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: 0,
            });
            return {
                ok: false,
                turnId,
                target: mention.name,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // ── HTTP 辅助 ─────────────────────────────────────────

    private sendJSON(
        res: http.ServerResponse,
        status: number,
        data: Record<string, unknown>,
    ): void {
        const body = JSON.stringify(data);
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Content-Length": Buffer.byteLength(body).toString(),
        });
        res.end(body);
    }

    private sendCORS(res: http.ServerResponse): void {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
    }
}

type SubAgentEvent =
    | SubAgentStartEvent
    | SubAgentProgressEvent
    | SubAgentCompleteEvent
    | SubAgentErrorEvent
    | SubAgentResultReadyEvent;

// ════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
                req.destroy();
                reject(new Error("请求体过大"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}
