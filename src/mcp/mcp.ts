// src/mcp/mcp.ts
// MCP (Model Context Protocol) 客户端实现
// 支持 stdio 与 SSE 两种传输方式，将 MCP 服务器工具适配为项目 BaseTool，直接融入 Agent 工具链。

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import http from "http";
import https from "https";
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

/** MCP 服务器配置 */
export interface MCPServerConfig {
    /** 服务器标识名（用于工具名前缀） */
    name: string;
    /** 传输方式："stdio"（子进程）| "sse"（HTTP SSE），未指定时自动推断 */
    transport?: "stdio" | "sse";
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

        this.process = spawn(this.config.command, this.config.args ?? [], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...this.config.env },
            cwd: this.config.cwd,
            shell: true, // Windows 需要 shell 来解析 .cmd 和 PATH
        });

        this.process.on("error", (err) => {
            console.error(`[MCP ${this.serverName}] 进程错误:`, err.message);
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
// MCPClient —— 统一客户端（传输无关）
// ════════════════════════════════════════════════════════════════

/** 等待中的 JSON-RPC 请求 */
interface PendingCallbacks {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
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
        const transportType =
            config.transport ??
            (config.command ? "stdio" : config.url ? "sse" : undefined);

        if (transportType === "stdio") {
            this.transport = new StdioTransport(config);
        } else if (transportType === "sse") {
            this.transport = new SSETransport(config);
        } else {
            throw new Error(
                `[MCP ${config.name}] 配置必须指定 transport ("stdio"|"sse") 或包含 "command"/"url"`,
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
                protocolVersion: "2024-11-05",
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
            throw new Error(
                `MCP "${this.serverName}" 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
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

        this.name = `mcp_${client.serverName}_${toolDef.name}`;
        this.description =
            toolDef.description ?? `${toolDef.name} (来自 MCP 服务 ${client.serverName})`;
        this.parameters = mcpSchemaToParams(toolDef.inputSchema);
    }

    async execute(args: Record<string, unknown>): Promise<string> {
        return this.client.callTool(this.mcpToolName, args);
    }
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

    /** 发现所有已连接服务器的工具，返回可直接注册到 ToolRegistry 的 BaseTool[] */
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
