// src/agent/event-server.ts
//
// 轻量 HTTP 事件服务器 —— 接收外部进程推送的事件。
//
// 启动后监听本地端口，外部可通过 HTTP POST 将事件注入到 Agent 的消息队列中。
// 这是"外部事件源"能力的具体实现 —— PowerShell、curl、任何 HTTP 客户端都可推送事件。
//
// 使用方式：
//   设置环境变量 EVENT_SERVER_PORT=9400 启动 fyuobot
//   curl -X POST http://localhost:9400/event -H "Content-Type: application/json" -d "..."
//
// 端点：
//   POST /event          — 推送单个事件（JSON body = AgentEvent）
//   POST /query          — 推送用户查询事件（简化的 JSON body = { query: string }）
//   GET  /health         — 健康检查

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { MessageQueue } from "./message-queue.js";
import { AgentEventType as ET, getEventPriority } from "./events.js";
import type {
    UserQueryEvent,
    AgentEvent,
} from "./events.js";

// ── 类型 ──────────────────────────────────────────────────────

export interface EventServerOptions {
    /** 监听端口（默认 9400） */
    port?: number;
    /** 监听地址（默认 "127.0.0.1"，仅本地可访问） */
    host?: string;
    /** 事件总线 */
    bus: MessageQueue;
}

// ── 事件服务器 ────────────────────────────────────────────────

/**
 * 启动一个轻量 HTTP 服务器，接收外部事件推送。
 *
 * 安全说明：
 *   - 默认监听 127.0.0.1，仅本机可访问
 *   - 无身份验证 —— 仅用于本地开发和测试
 *   - 生产环境应放在反向代理后面或添加 token 验证
 */
export function startEventServer(options: EventServerOptions): {
    /** 服务器实例 */
    server: ReturnType<typeof createServer>;
    /** 停止服务器的 Promise */
    stop: () => Promise<void>;
    /** 服务器地址 */
    address: string;
} {
    const { port = 9401, host = "127.0.0.1", bus } = options;

    const server = createServer(
        async (req: IncomingMessage, res: ServerResponse) => {
            // CORS headers（允许本地开发工具访问）
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader(
                "Access-Control-Allow-Methods",
                "GET, POST, OPTIONS",
            );
            res.setHeader(
                "Access-Control-Allow-Headers",
                "Content-Type",
            );

            // 预检请求
            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }

            // ── 健康检查 ──
            if (req.method === "GET" && req.url === "/health") {
                res.writeHead(200, {
                    "Content-Type": "application/json",
                });
                res.end(
                    JSON.stringify({
                        status: "ok",
                        queueSize: bus.size,
                        queueSubscribers: bus.subscriberCount,
                    }),
                );
                return;
            }

            // ── 推送事件 ──
            if (
                req.method === "POST" &&
                (req.url === "/event" || req.url === "/query")
            ) {
                try {
                    const body = await readRequestBody(req);

                    if (!body) {
                        res.writeHead(400, {
                            "Content-Type": "application/json",
                        });
                        res.end(
                            JSON.stringify({
                                error: "请求体为空",
                            }),
                        );
                        return;
                    }

                    let event: AgentEvent;

                    if (req.url === "/query") {
                        // 简化接口：只需传 { query: "..." }
                        const { query } = JSON.parse(body) as {
                            query: string;
                        };

                        if (!query || typeof query !== "string") {
                            res.writeHead(400, {
                                "Content-Type": "application/json",
                            });
                            res.end(
                                JSON.stringify({
                                    error: '缺少 "query" 字段',
                                }),
                            );
                            return;
                        }

                        const userEvent: UserQueryEvent = {
                            type: ET.USER_QUERY,
                            turnId: `ext_${Date.now()}`,
                            query: query.trim(),
                            timestamp: Date.now(),
                        };
                        event = userEvent;
                    } else {
                        // 完整事件接口：传任意 AgentEvent JSON
                        const parsed = JSON.parse(body) as AgentEvent;

                        if (!parsed.type) {
                            res.writeHead(400, {
                                "Content-Type": "application/json",
                            });
                            res.end(
                                JSON.stringify({
                                    error: '事件必须包含 "type" 字段',
                                }),
                            );
                            return;
                        }

                        event = parsed;
                    }

                    // 入队
                    bus.enqueue(event);

                    console.log(
                        `[event-server] 收到外部事件: type=${event.type}`,
                    );

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                    });
                    res.end(
                        JSON.stringify({
                            ok: true,
                            eventType: event.type,
                            queueSize: bus.size,
                        }),
                    );
                } catch (err) {
                    console.warn(
                        "[event-server] 处理请求失败:",
                        err instanceof Error ? err.message : String(err),
                    );
                    res.writeHead(400, {
                        "Content-Type": "application/json",
                    });
                    res.end(
                        JSON.stringify({
                            error: "无效的请求",
                            detail:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                        }),
                    );
                }
                return;
            }

            // ── 404 ──
            res.writeHead(404, {
                "Content-Type": "application/json",
            });
            res.end(JSON.stringify({ error: "未找到" }));
        },
    );

    return {
        server,
        address: `http://${host}:${port}`,
        stop: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            }),
    };
}

// ── 内部辅助 ──────────────────────────────────────────────────

/**
 * 读取 HTTP 请求体为字符串。
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf-8"));
        });
        req.on("error", reject);
    });
}
