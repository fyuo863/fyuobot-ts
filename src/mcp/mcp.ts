// src/mcp/mcp.ts
// MCP (Model Context Protocol) 客户端实现
// 支持 stdio、SSE 与 streamable HTTP 三种传输方式，将 MCP 服务器工具适配为项目 BaseTool，直接融入 Agent 工具链。

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import http from "http";
import https from "https";
import {
    buildHostShellCommand,
    hostCommandEnv,
    hostShellLabel,
    selectHostShell,
} from "../utils/host-shell.js";
import { BaseTool, type ToolParam } from "../tools/basetool.js";

// ════════════════════════════════════════════════════════════════
// JSON-RPC 2.0 类型
// ════════════════════════════════════════════════════════════════

interface JSONRPCRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: Record<string, unknown>;
}

interface JSONRPCError {
    code: number;
    message: string;
    data?: unknown;
}

type JSONRPCMessage =
    | { jsonrpc: "2.0"; id: number; result?: unknown; error?: JSONRPCError }
    | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> };

// ════════════════════════════════════════════════════════════════
// MCP 协议类型
// ════════════════════════════════════════════════════════════════

interface MCPToolDef {
    name: string;
    description?: string;
    inputSchema: MCPInputSchema;
}

interface MCPInputSchema {
    type: "object";
    properties?: Record<string, MCPPropertySchema>;
    required?: string[];
}

interface MCPPropertySchema {
    type?: string;
    description?: string;
    enum?: string[];
    items?: MCPPropertySchema;
}

interface MCPListToolsResult {
    tools: MCPToolDef[];
}

interface MCPCallToolResult {
    content: MCPContent[];
    isError?: boolean;
}

interface MCPContent {
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
}

interface MCPInitializeResult {
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo?: { name: string; version: string };
}

// ════════════════════════════════════════════════════════════════
// 传输层抽象
// ════════════════════════════════════════════════════════════════

/** 传输层接口：负责原始 JSON-RPC 字符串的双向传递 */
interface Transport {
    /** 建立连接 */
    start(): Promise<void>;
    /** 断开连接 */
    stop(): void;
    /** 发送 JSON-RPC 字符串 */
    send(data: string): void;
    /** 注册入站消息回调 */
    onMessage(handler: (msg: unknown) => void): void;
    /** 连接是否存活 */
    readonly isRunning: boolean;
}

export type MCPTransportType = "stdio" | "sse" | "streamablehttp";

/** MCP 服务器配置 */
export interface MCPServerConfig {
    /** 服务器标识名（用于工具名前缀） */
    name: string;
    /** 传输方式："stdio"（子进程）| "sse"（HTTP SSE）| "streamablehttp"（标准 HTTP） */
    transport?: MCPTransportType;
    /** 标准 MCP 配置常用字段；与 transport 含义一致 */
    type?: MCPTransportType;
    /** 是否启用，false 时跳过连接。默认 true */
    enabled?: boolean;

    // ── stdio 模式 ──
    /** 启动命令（stdio 模式） */
    command?: string;
    /** 命令参数 */
    args?: string[];

    // ── SSE 模式 ──
    /** SSE 端点 URL，如 "http://localhost:3000/sse"（SSE 模式） */
    url?: string;
    /** 自定义请求头（SSE 模式，如认证令牌） */
    headers?: Record<string, string>;

    // ── 通用 ──
    /** 环境变量 */
    env?: Record<string, string>;
    /** 工作目录 */
    cwd?: string;
    /** initialize 时声明的 MCP 协议版本，默认 2025-06-18 */
    protocolVersion?: string;
}

type MCPServerMapEntry = Omit<MCPServerConfig, "name">;

interface MCPConfigFile {
    mcpServers?: MCPServerConfig[] | Record<string, MCPServerMapEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inferTransportType(
    config: Pick<MCPServerConfig, "transport" | "type" | "command" | "url">,
): MCPTransportType | undefined {
    return (
        config.transport ??
        config.type ??
        (config.command ? "stdio" : config.url ? "sse" : undefined)
    );
}

function normalizeServerConfig(
    name: string,
    entry: MCPServerMapEntry,
): MCPServerConfig {
    const normalized: MCPServerConfig = {
        ...entry,
        name,
    };
    const transport = inferTransportType(normalized);
    if (transport) {
        normalized.transport = transport;
    }
    return normalized;
}

export function normalizeMCPConfig(config: unknown): MCPServerConfig[] {
    if (!isRecord(config)) return [];
    const mcpServers = (config as MCPConfigFile).mcpServers;
    if (!mcpServers) return [];

    if (Array.isArray(mcpServers)) {
        return mcpServers
            .filter((entry): entry is MCPServerConfig => isRecord(entry))
            .map((entry) => {
                const name =
                    typeof entry.name === "string" && entry.name.trim()
                        ? entry.name.trim()
                        : "unnamed";
                return normalizeServerConfig(name, entry);
            });
    }

    if (!isRecord(mcpServers)) return [];

    return Object.entries(mcpServers)
        .filter(([, entry]) => isRecord(entry))
        .map(([name, entry]) => normalizeServerConfig(name, entry));
}

// ════════════════════════════════════════════════════════════════
// StdioTransport —— 子进程 stdio
// ════════════════════════════════════════════════════════════════

class StdioTransport implements Transport {
    private process: ChildProcess | null = null;
    private messageHandler: ((msg: unknown) => void) | null = null;
    private serverName: string;
    private config: MCPServerConfig;

    constructor(config: MCPServerConfig) {
        this.config = config;
        this.serverName = config.name;
    }

    async start(): Promise<void> {
        if (!this.config.command) {
            throw new Error(`[MCP ${this.serverName}] stdio 模式缺少 command`);
        }

        const isWindows = process.platform === "win32";
        const shell = selectHostShell();
        const command = buildHostShellCommand(
            this.config.command,
            this.config.args ?? [],
        );

        this.process = spawn(shell.command, shell.args(command), {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...hostCommandEnv(isWindows), ...this.config.env },
            cwd: this.config.cwd,
            windowsHide: isWindows,
        });

        this.process.on("error", (err) => {
            console.error(
                `[MCP ${this.serverName}] 进程错误 (${hostShellLabel(shell)}):`,
                err.message,
            );
        });
        this.process.on("exit", (code, signal) => {
            if (code !== 0 && code !== null) {
                console.warn(`[MCP ${this.serverName}] 进程退出 (code=${code}, signal=${signal})`);
            }
        });

        // 行读取
        const rl = createInterface({ input: this.process.stdout! });
        rl.on("line", (line: string) => {
            try {
                const msg = JSON.parse(line);
                this.messageHandler?.(msg);
            } catch {
                // stderr 日志不是 JSON，忽略
            }
        });
    }

    send(data: string): void {
        if (!this.process?.stdin) {
            throw new Error(`[MCP ${this.serverName}] 未启动`);
        }
        this.process.stdin.write(data + "\n");
    }

    onMessage(handler: (msg: unknown) => void): void {
        this.messageHandler = handler;
    }

    stop(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }

    get isRunning(): boolean {
        return this.process !== null && this.process.exitCode === null;
    }
}

// ════════════════════════════════════════════════════════════════
// SSETransport —— HTTP SSE 流式传输
// ════════════════════════════════════════════════════════════════

/**
 * 简易 SSE 解析器：从文本块中提取 SSE 事件。
 * 参考 W3C SSE 规范：event: / data: / id: / retry: 字段，空行结束。
 */
class SSEParser {
    private buffer = "";

    /** 喂入一个文本块，返回本轮解析出的 { event, data } 列表 */
    feed(chunk: string): { event: string; data: string }[] {
        this.buffer += chunk;
        const events: { event: string; data: string }[] = [];

        // 按空行分割事件
        const parts = this.buffer.split(/\n\n/);
        // 最后一个可能不完整，保留在 buffer
        this.buffer = parts.pop() ?? "";

        for (const part of parts) {
            const lines = part.split("\n");
            let event = "message"; // 默认事件类型
            const dataLines: string[] = [];

            for (const line of lines) {
                if (line.startsWith("event:")) {
                    event = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).replace(/^ /, ""));
                }
                // 忽略 id: / retry: / 注释行（以 : 开头）
            }

            if (dataLines.length > 0) {
                events.push({ event, data: dataLines.join("\n") });
            }
        }

        return events;
    }
}

class SSETransport implements Transport {
    private serverName: string;
    private config: MCPServerConfig;
    private sseRequest: http.ClientRequest | null = null;
    private messageHandler: ((msg: unknown) => void) | null = null;
    private messageUrl = "";
    private running = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 3;

    constructor(config: MCPServerConfig) {
        this.config = config;
        this.serverName = config.name;
    }

    async start(): Promise<void> {
        if (!this.config.url) {
            throw new Error(`[MCP ${this.serverName}] SSE 模式缺少 url`);
        }

        await this.#connectSSE();

        // 等待 endpoint 事件 → messageUrl 被设置
        // 服务器必须在连接后立即发送 endpoint 事件
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`[MCP ${this.serverName}] 等待 endpoint 事件超时`));
            }, 15_000);

            const check = setInterval(() => {
                if (this.messageUrl) {
                    clearTimeout(timeout);
                    clearInterval(check);
                    resolve();
                }
            }, 50);
        });

        this.running = true;
        this.reconnectAttempts = 0;
    }

    /** 发起 SSE 长连接 */
    #connectSSE(): Promise<void> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(this.config.url!);
            const httpModule = urlObj.protocol === "https:" ? https : http;

            const requestOptions: http.RequestOptions = {
                method: "GET",
                headers: {
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache",
                    ...this.config.headers,
                },
            };

            const req = httpModule.request(this.config.url!, requestOptions, (res) => {
                if (res.statusCode !== 200) {
                    const err = new Error(
                        `[MCP ${this.serverName}] SSE 连接失败: HTTP ${res.statusCode}`,
                    );
                    reject(err);
                    return;
                }

                this.sseRequest = req;
                const parser = new SSEParser();

                res.on("data", (chunk: Buffer) => {
                    const events = parser.feed(chunk.toString());
                    for (const ev of events) {
                        this.#handleSSEEvent(ev, resolve);
                    }
                });

                res.on("error", (err) => {
                    console.error(`[MCP ${this.serverName}] SSE 流错误:`, err.message);
                    this.#tryReconnect();
                });

                res.on("end", () => {
                    this.running = false;
                    this.#tryReconnect();
                });
            });

            req.on("error", (err) => {
                reject(new Error(`[MCP ${this.serverName}] SSE 请求失败: ${err.message}`));
            });

            req.end();
        });
    }

    #handleSSEEvent(
        ev: { event: string; data: string },
        onEndpoint?: () => void,
    ): void {
        switch (ev.event) {
            case "endpoint": {
                // 服务器指定的消息发送端点
                this.messageUrl = this.#resolveEndpoint(ev.data);
                console.log(`[MCP ${this.serverName}] SSE endpoint → ${this.messageUrl}`);
                onEndpoint?.();
                break;
            }
            case "message": {
                // JSON-RPC 响应或通知
                try {
                    const msg = JSON.parse(ev.data);
                    this.messageHandler?.(msg);
                } catch {
                    console.warn(`[MCP ${this.serverName}] 无法解析 SSE message:`, ev.data.slice(0, 100));
                }
                break;
            }
            // 其他事件类型静默忽略
        }
    }

    /** 将 endpoint data 解析为绝对 URL */
    #resolveEndpoint(endpointData: string): string {
        const sseUrl = new URL(this.config.url!);

        // 如果 endpoint 是完整 URL，直接使用
        if (endpointData.startsWith("http://") || endpointData.startsWith("https://")) {
            return endpointData;
        }

        // 相对路径：拼接到 SSE URL 的 origin
        const path = endpointData.startsWith("/") ? endpointData : `/${endpointData}`;
        return `${sseUrl.origin}${path}`;
    }

    /** 断线重连 */
    #tryReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn(`[MCP ${this.serverName}] SSE 重连次数已达上限`);
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
        console.log(
            `[MCP ${this.serverName}] SSE 将在 ${delay / 1000}s 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        );
        setTimeout(() => {
            if (!this.running) {
                this.#connectSSE().catch((e) =>
                    console.error(`[MCP ${this.serverName}] SSE 重连失败:`, e.message),
                );
            }
        }, delay);
    }

    send(data: string): void {
        if (!this.messageUrl) {
            throw new Error(`[MCP ${this.serverName}] SSE 尚未就绪（未收到 endpoint）`);
        }

        const url = new URL(this.messageUrl);

        // 以 POST 发送 JSON-RPC 请求
        const httpModule = url.protocol === "https:" ? https : http;
        const body = data;

        const req = httpModule.request(
            url,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body).toString(),
                    ...this.config.headers,
                },
            },
            (res) => {
                // 某些实现直接返回响应（非 SSE），处理之
                if (res.statusCode === 200 || res.statusCode === 202) {
                    let responseBody = "";
                    res.on("data", (chunk: Buffer) => {
                        responseBody += chunk.toString();
                    });
                    res.on("end", () => {
                        if (responseBody.trim()) {
                            try {
                                const msg = JSON.parse(responseBody);
                                // 如果 POST 返回了 JSON-RPC 响应（非标准但常见），转发给 handler
                                if (msg.jsonrpc === "2.0" && msg.id !== undefined) {
                                    this.messageHandler?.(msg);
                                }
                            } catch {
                                // 非 JSON 响应忽略
                            }
                        }
                    });
                } else {
                    console.warn(
                        `[MCP ${this.serverName}] POST 返回 HTTP ${res.statusCode}`,
                    );
                }
            },
        );

        req.on("error", (err) => {
            console.error(`[MCP ${this.serverName}] POST 失败:`, err.message);
        });

        req.write(body);
        req.end();
    }

    onMessage(handler: (msg: unknown) => void): void {
        this.messageHandler = handler;
    }

    stop(): void {
        this.running = false;
        if (this.sseRequest) {
            this.sseRequest.destroy();
            this.sseRequest = null;
        }
    }

    get isRunning(): boolean {
        return this.running;
    }
}

// ════════════════════════════════════════════════════════════════
// StreamableHTTPTransport —— 标准 MCP Streamable HTTP
// ════════════════════════════════════════════════════════════════

class StreamableHTTPTransport implements Transport {
    private serverName: string;
    private config: MCPServerConfig;
    private messageHandler: ((msg: unknown) => void) | null = null;
    private running = false;
    private sessionId: string | null = null;

    constructor(config: MCPServerConfig) {
        this.config = config;
        this.serverName = config.name;
    }

    async start(): Promise<void> {
        if (!this.config.url) {
            throw new Error(
                `[MCP ${this.serverName}] streamablehttp 模式缺少 url`,
            );
        }
        this.running = true;
    }

    send(data: string): void {
        if (!this.running) {
            throw new Error(`[MCP ${this.serverName}] 未启动`);
        }

        const requestId = this.#extractRequestId(data);
        const url = new URL(this.config.url!);
        const httpModule = url.protocol === "https:" ? https : http;
        const body = data;
        const headers: Record<string, string> = {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body).toString(),
            ...this.config.headers,
        };

        if (this.sessionId) {
            headers["Mcp-Session-Id"] = this.sessionId;
        }

        const req = httpModule.request(
            url,
            {
                method: "POST",
                headers,
            },
            (res) => {
                const sessionId = res.headers["mcp-session-id"];
                if (typeof sessionId === "string" && sessionId.trim()) {
                    this.sessionId = sessionId;
                }

                const contentType = String(res.headers["content-type"] ?? "");
                if ((res.statusCode ?? 500) >= 400) {
                    let responseBody = "";
                    res.on("data", (chunk: Buffer) => {
                        responseBody += chunk.toString();
                    });
                    res.on("end", () => {
                        const authHint =
                            res.statusCode === 401 || res.statusCode === 403
                                ? "，请检查 token、Authorization 头格式或服务端访问权限"
                                : "";
                        const message =
                            `[MCP ${this.serverName}] HTTP 返回 ${res.statusCode}` +
                            authHint +
                            (responseBody.trim()
                                ? `: ${responseBody.trim().slice(0, 1200)}`
                                : "");
                        console.warn(message);
                        this.#emitTransportError(message, requestId);
                    });
                    return;
                }

                if (contentType.includes("text/event-stream")) {
                    const parser = new SSEParser();
                    res.on("data", (chunk: Buffer) => {
                        const events = parser.feed(chunk.toString());
                        for (const ev of events) {
                            if (ev.event === "message") {
                                this.#emitJSON(ev.data);
                            }
                        }
                    });
                    res.on("error", (err) => {
                        console.error(
                            `[MCP ${this.serverName}] HTTP 流错误:`,
                            err.message,
                        );
                    });
                    return;
                }

                let responseBody = "";
                res.on("data", (chunk: Buffer) => {
                    responseBody += chunk.toString();
                });
                res.on("end", () => {
                    const trimmed = responseBody.trim();
                    if (!trimmed) return;
                    this.#emitJSON(trimmed);
                });
            },
        );

        req.on("error", (err) => {
            console.error(`[MCP ${this.serverName}] HTTP 请求失败:`, err.message);
            this.#emitTransportError(
                `[MCP ${this.serverName}] HTTP 请求失败: ${err.message}`,
                requestId,
            );
        });

        req.write(body);
        req.end();
    }

    onMessage(handler: (msg: unknown) => void): void {
        this.messageHandler = handler;
    }

    stop(): void {
        this.running = false;
        if (!this.sessionId || !this.config.url) return;

        const url = new URL(this.config.url);
        const httpModule = url.protocol === "https:" ? https : http;
        const req = httpModule.request(url, {
            method: "DELETE",
            headers: {
                "Mcp-Session-Id": this.sessionId,
                ...this.config.headers,
            },
        });
        req.on("error", () => {
            // 会话清理失败不阻塞退出
        });
        req.end();
        this.sessionId = null;
    }

    get isRunning(): boolean {
        return this.running;
    }

    #emitJSON(payload: string): void {
        try {
            const parsed = JSON.parse(payload);
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    this.messageHandler?.(item);
                }
                return;
            }
            this.messageHandler?.(parsed);
        } catch {
            console.warn(
                `[MCP ${this.serverName}] 无法解析 HTTP 响应:`,
                payload.slice(0, 100),
            );
        }
    }

    #emitTransportError(message: string, requestId?: number): void {
        if (requestId === undefined) return;
        this.messageHandler?.({
            jsonrpc: "2.0",
            id: requestId,
            error: {
                code: -32000,
                message,
            },
        });
    }

    #extractRequestId(payload: string): number | undefined {
        try {
            const parsed = JSON.parse(payload) as { id?: unknown };
            return typeof parsed.id === "number" ? parsed.id : undefined;
        } catch {
            return undefined;
        }
    }
}

// ════════════════════════════════════════════════════════════════
// MCPClient —— 统一客户端（传输无关）
// ════════════════════════════════════════════════════════════════

/** 等待中的 JSON-RPC 请求 */
interface PendingCallbacks {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

function buildStreamableHTTPHint(error: Error): string {
    const message = error.message;
    if (
        !message.includes('HTTP 返回 400') ||
        !message.includes('"code":-32700') ||
        !message.includes('Parse error: Invalid JSON')
    ) {
        return message;
    }

    return (
        `${message}\n` +
        "检测到服务端在收到合法 application/json JSON-RPC 请求后仍返回 -32700。" +
        " 这通常不是客户端 JSON.stringify 的问题，而是服务端 streamable HTTP 路由把已解析的 req.body 再次按原始 JSON 字符串处理，" +
        "或使用了与 @modelcontextprotocol/sdk 不兼容的请求解析方式。"
    );
}

export class MCPClient {
    readonly serverName: string;
    private transport!: Transport;
    private config: MCPServerConfig;
    private requestId = 0;
    private pending = new Map<number, PendingCallbacks>();
    private toolCache: MCPToolDef[] | null = null;
    private started = false;

    constructor(config: MCPServerConfig) {
        this.config = config;
        this.serverName = config.name;

        // 根据 transport 字段或字段存在性选择传输方式
        const transportType = inferTransportType(config);

        if (transportType === "stdio") {
            this.transport = new StdioTransport(config);
        } else if (transportType === "sse") {
            this.transport = new SSETransport(config);
        } else if (transportType === "streamablehttp") {
            this.transport = new StreamableHTTPTransport(config);
        } else {
            throw new Error(
                `[MCP ${config.name}] 配置必须指定 transport/type ("stdio"|"sse"|"streamablehttp") 或包含 "command"/"url"`,
            );
        }

        this.transport.onMessage((msg) => this.#handleMessage(msg));
    }

    // ── 生命周期 ──────────────────────────────────────────

    async start(): Promise<void> {
        if (this.started) return;

        // 1. 建立传输连接
        await this.transport.start();

        try {
            // 2. MCP 初始化握手
            const initResult = await this.#sendRequest("initialize", {
                protocolVersion:
                    this.config.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                clientInfo: { name: "ts-learn-agent", version: "1.0.0" },
            }) as MCPInitializeResult;

            console.log(
                `[MCP ${this.serverName}] 已连接 — ` +
                `${initResult.serverInfo?.name ?? "?"} v${initResult.serverInfo?.version ?? "?"}`,
            );

            // 3. 发送 initialized 通知
            this.#sendNotification("notifications/initialized", {});

            this.started = true;
        } catch (e) {
            this.transport.stop();
            const baseMessage =
                e instanceof Error ? e.message : String(e);
            const enhancedMessage =
                this.config.transport === "streamablehttp" ||
                this.config.type === "streamablehttp"
                    ? buildStreamableHTTPHint(
                        e instanceof Error ? e : new Error(baseMessage),
                    )
                    : baseMessage;
            throw new Error(
                `MCP "${this.serverName}" 初始化失败: ${enhancedMessage}`,
            );
        }
    }

    stop(): void {
        this.transport.stop();
        this.started = false;
        this.toolCache = null;

        // 拒绝所有等待中的请求
        for (const [, cb] of this.pending) {
            clearTimeout(cb.timeout);
            cb.reject(new Error(`MCP "${this.serverName}" 连接已断开`));
        }
        this.pending.clear();
    }

    get isRunning(): boolean {
        return this.started && this.transport.isRunning;
    }

    // ── 工具操作 ──────────────────────────────────────────

    async listTools(): Promise<MCPToolDef[]> {
        if (this.toolCache) return this.toolCache;
        const result = await this.#sendRequest("tools/list") as MCPListToolsResult;
        this.toolCache = result.tools ?? [];
        return this.toolCache;
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        const result = await this.#sendRequest("tools/call", {
            name,
            arguments: args,
        }) as MCPCallToolResult;

        if (result.isError) {
            const text = result.content.map((c) => c.text ?? "").join("\n");
            throw new Error(`MCP 工具 "${name}" 返回错误: ${text}`);
        }

        return result.content
            .map((c) => {
                if (c.type === "text") return c.text ?? "";
                if (c.type === "image") return `[图片: ${c.mimeType ?? "unknown"}]`;
                if (c.type === "resource") return `[资源: ${c.mimeType ?? "unknown"}]`;
                return "";
            })
            .join("\n");
    }

    // ── 内部：JSON-RPC ─────────────────────────────────────

    #sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
        const id = ++this.requestId;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP "${this.serverName}" 请求超时: ${method}`));
            }, 60_000);

            this.pending.set(id, { resolve, reject, timeout });

            const request: JSONRPCRequest = {
                jsonrpc: "2.0",
                id,
                method,
                params: params ?? {},
            };

            try {
                this.transport.send(JSON.stringify(request));
            } catch (e) {
                clearTimeout(timeout);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    #sendNotification(method: string, params?: Record<string, unknown>): void {
        try {
            this.transport.send(
                JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
            );
        } catch {
            // 通知静默失败
        }
    }

    #handleMessage(msg: unknown): void {
        const m = msg as JSONRPCMessage & { id?: number; error?: JSONRPCError; result?: unknown };

        // 通知（无 id）
        if (m.id === undefined || m.id === null) {
            return;
        }

        const id = m.id;
        const cb = this.pending.get(id);
        if (!cb) return;

        clearTimeout(cb.timeout);
        this.pending.delete(id);

        if (m.error) {
            cb.reject(new Error(`MCP 错误 ${m.error.code}: ${m.error.message}`));
        } else {
            cb.resolve(m.result);
        }
    }
}

// ════════════════════════════════════════════════════════════════
// MCPTool —— 将 MCP 工具包装为 BaseTool
// ════════════════════════════════════════════════════════════════

function mcpTypeToParamType(schema: MCPPropertySchema): ToolParam["type"] {
    const t = schema.type ?? "string";
    if (t === "number" || t === "integer") return "number";
    if (t === "boolean") return "boolean";
    if (t === "array") return "array";
    return "string";
}

function mcpSchemaToParams(schema: MCPInputSchema): ToolParam[] {
    if (!schema.properties) return [];

    const params: ToolParam[] = [];
    const required = new Set(schema.required ?? []);

    for (const [name, prop] of Object.entries(schema.properties)) {
        const param: ToolParam = {
            name,
            type: mcpTypeToParamType(prop),
            description: prop.description ?? name,
            required: required.has(name),
        };
        if (prop.type === "array" && prop.items?.type) {
            param.itemsType = prop.items.type;
        }
        if (prop.enum) param.enum = prop.enum;
        params.push(param);
    }

    return params;
}

export class MCPTool extends BaseTool {
    name: string;
    description: string;
    parameters: ToolParam[];

    private client: MCPClient;
    private mcpToolName: string;

    constructor(client: MCPClient, toolDef: MCPToolDef) {
        super();
        this.client = client;
        this.mcpToolName = toolDef.name;

        this.name = `mcp_${sanitizeNameSegment(client.serverName)}_${sanitizeNameSegment(toolDef.name)}`;
        this.description =
            toolDef.description ?? `${toolDef.name} (来自 MCP 服务 ${client.serverName})`;
        this.parameters = mcpSchemaToParams(toolDef.inputSchema);
    }

    async execute(args: Record<string, unknown>): Promise<string> {
        return this.client.callTool(this.mcpToolName, args);
    }
}

function sanitizeNameSegment(value: string): string {
    const normalized = value
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return normalized || "unnamed";
}

// ════════════════════════════════════════════════════════════════
// MCPManager —— 多服务器生命周期管理
// ════════════════════════════════════════════════════════════════

export class MCPManager {
    private clients = new Map<string, MCPClient>();
    private connected = false;

    /**
     * 连接多个 MCP 服务器（并行，失败不阻塞其他）。
     *
     * ```typescript
     * await manager.connect([
     *   // stdio 模式
     *   { name: "codegraph", command: "codegraph", args: ["mcp"] },
     *   // SSE 模式
     *   { name: "remote", url: "http://localhost:3456/sse", headers: { "Authorization": "Bearer xxx" } },
     * ]);
     * ```
     */
    async connect(configs: MCPServerConfig[]): Promise<void> {
        if (this.connected) {
            console.warn("⚠ MCPManager 已连接，先调用 disconnect() 再重新连接");
            return;
        }

        // 过滤禁用的服务器
        const activeConfigs = configs.filter((c) => c.enabled !== false);

        if (activeConfigs.length < configs.length) {
            const skipped = configs.filter((c) => c.enabled === false).map((c) => c.name);
            console.log(`[MCPManager] 跳过禁用的服务器: ${skipped.join(", ")}`);
        }

        const results = await Promise.allSettled(
            activeConfigs.map(async (config) => {
                const client = new MCPClient(config);
                await client.start();
                this.clients.set(config.name, client);
                return config.name;
            }),
        );

        const succeeded: string[] = [];
        for (const r of results) {
            if (r.status === "fulfilled") succeeded.push(r.value);
            else console.error(`[MCPManager] 连接失败: ${r.reason}`);
        }

        if (succeeded.length > 0) {
            this.connected = true;
            console.log(
                `[MCPManager] 已连接 ${succeeded.length}/${configs.length} 个服务器: ${succeeded.join(", ")}`,
            );
        }
    }

    /**
     * 发现所有已连接服务器的工具，返回可直接注册到 ToolRegistry 的 BaseTool[]。
     *
     * 工具按名称字母顺序排序，确保跨运行的注册顺序一致性，
     * 防止因顺序差异导致 LLM prompt cache 失效。
     */
    async discoverAllTools(): Promise<BaseTool[]> {
        const allTools: BaseTool[] = [];

        for (const [, client] of this.clients) {
            if (!client.isRunning) continue;
            try {
                const toolDefs = await client.listTools();
                for (const td of toolDefs) {
                    allTools.push(new MCPTool(client, td));
                }
            } catch (e) {
                console.error(
                    `[MCPManager] 获取 ${client.serverName} 工具列表失败: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }

        // 按名称字母顺序排序，确保注册顺序确定性（缓存关键）
        allTools.sort((a, b) => a.name.localeCompare(b.name));

        return allTools;
    }

    getClient(name: string): MCPClient | undefined {
        return this.clients.get(name);
    }

    async disconnect(): Promise<void> {
        for (const client of this.clients.values()) {
            client.stop();
        }
        this.clients.clear();
        this.connected = false;
    }

    get serverCount(): number {
        return [...this.clients.values()].filter((c) => c.isRunning).length;
    }
}
