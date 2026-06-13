import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { BaseTool, type ToolParam } from "../../../src/tools/basetool.js";
import type { Agent } from "../../../src/agent/agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, "public");

interface WebUIConfig {
    port?: number;
    apiBaseUrl?: string;
}

function loadConfig(): WebUIConfig {
    const configPath = join(__dirname, "config.json");
    try {
        if (existsSync(configPath)) {
            return JSON.parse(readFileSync(configPath, "utf-8")) as WebUIConfig;
        }
    } catch {
        // Ignore invalid config and use defaults.
    }
    return {};
}

function contentType(path: string): string {
    const ext = extname(path).toLowerCase();
    switch (ext) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".js":
            return "application/javascript; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        default:
            return "text/plain; charset=utf-8";
    }
}

export class WebUITool extends BaseTool {
    name = "web-ui";
    description = "查看 Web UI 服务状态。页面用于展示 Agent 状态和全局事件流。";
    parameters: ToolParam[] = [];

    private server: http.Server | null = null;
    private agent: Agent | null = null;
    private port = 3478;
    private apiBaseUrl = "http://127.0.0.1:3456";

    async onInit(agent: Agent): Promise<void> {
        this.agent = agent;
        const config = loadConfig();
        this.port = config.port ?? 3478;
        this.apiBaseUrl = config.apiBaseUrl ?? "http://127.0.0.1:3456";

        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.listen(this.port, () => resolve());
            this.server!.on("error", reject);
        });

        console.log(`🌍 [web-ui] 页面已启动 → http://127.0.0.1:${this.port}`);
    }

    async onDestroy(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
        });
        this.server = null;
        this.agent = null;
    }

    async execute(_args: Record<string, unknown>): Promise<string> {
        const busy = this.agent?.status.busy ?? false;
        return [
            "🌍 Web UI 状态:",
            `  - 运行中: ${this.server?.listening ? "✅ 是" : "❌ 否"}`,
            `  - 地址: http://127.0.0.1:${this.port}`,
            `  - API: ${this.apiBaseUrl}`,
            `  - Agent 忙碌: ${busy ? "是" : "否"}`,
        ].join("\n");
    }

    private handleRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): void {
        if (!req.url) {
            res.writeHead(400);
            res.end("Bad request");
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

        if (url.pathname === "/config.json") {
            this.sendJson(res, {
                apiBaseUrl: this.apiBaseUrl,
            });
            return;
        }

        const relativePath =
            url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const filePath = join(publicDir, relativePath);

        if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        const body = readFileSync(filePath);
        res.writeHead(200, {
            "Content-Type": contentType(filePath),
            "Content-Length": body.byteLength,
        });
        res.end(body);
    }

    private sendJson(
        res: http.ServerResponse,
        data: Record<string, unknown>,
    ): void {
        const body = JSON.stringify(data);
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body).toString(),
            "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
    }
}
