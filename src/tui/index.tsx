// src/tui/index.tsx
import { render } from "ink";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import process from "process";

import { ToolRegistry } from "../tools/basetool.js";
import { AgentRuntime } from "../agent/runtime.js";
import { MCPManager, type MCPServerConfig } from "../mcp/mcp.js";
import { AgentUI } from "./ui.js";

// ── 加载 MCP 服务器配置 ────────────────────────────────────
// 配置文件：.fyuobot/config.json

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(PROJECT_ROOT, ".fyuobot", "config.json");

function loadMCPServers(): MCPServerConfig[] {
    try {
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        const config = JSON.parse(raw) as { mcpServers?: MCPServerConfig[] };
        return config.mcpServers ?? [];
    } catch {
        console.warn(`⚠ 未找到 MCP 配置文件: ${CONFIG_PATH}，跳过远程工具加载`);
        return [];
    }
}

const MCP_SERVERS = loadMCPServers();

// ── Bootstrap ────────────────────────────────────────────

async function bootstrap() {
    let unmountUI: () => void;
    let mcpManager: MCPManager | undefined;

    try {
        // 1. 自动扫描本地工具目录
        const registry = await ToolRegistry.discoverAndRegister(
            new URL("../tools", import.meta.url),
        );

        // 2. 连接 MCP 服务器，发现远程工具并注入
        mcpManager = new MCPManager();
        if (MCP_SERVERS.length > 0) {
            await mcpManager.connect(MCP_SERVERS);
            const mcpTools = await mcpManager.discoverAllTools();
            for (const tool of mcpTools) {
                registry.register(tool);
            }
            console.log(`🔌 MCP: 已注入 ${mcpTools.length} 个远程工具`);
        }

        // 3. 创建单 Agent 运行时
        const runtime = AgentRuntime.createDefault(registry);
        const agent = runtime.getDefault();

        // 4. 挂载 React Ink UI
        const { unmount } = render(
            <AgentUI agent={agent} />,
        );
        unmountUI = unmount;

        // 5. 退出清理
        const cleanup = () => {
            mcpManager?.disconnect();
            if (unmountUI) unmountUI();
            process.stdout.write("\x1b[?25h");
            process.exit(0);
        };

        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
    } catch (error) {
        console.error("\n❌ 引擎启动遭受致命打击:", error);
        await mcpManager?.disconnect();
        process.exit(1);
    }
}

// 标准 Node.js ESM 入口判定机制
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}
