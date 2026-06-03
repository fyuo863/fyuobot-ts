// src/tui/index.tsx
import { render } from "ink";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import process from "process";

import { ToolRegistry } from "../tools/basetool.js";
import { AgentRuntime } from "../agent/runtime.js";
import { MCPManager, type MCPServerConfig } from "../mcp/mcp.js";
import { HistoryManager } from "../tools/history-manager.js";
import { AgentUI } from "./ui.js";
import { c } from "./colors.js"; // 引入你封装的模块

import { homedir } from "os";


/**
 * MCP 配置文件查找顺序：
 *   1. 项目本地 .fyuobot/config.json（优先）
 *   2. 用户 Home 目录 ~/.fyuobot/config.json（兜底）
 */
function resolveConfigPath(): string {
    const localPath = join(process.cwd(), ".fyuobot", "config.json");
    try {
        readFileSync(localPath, "utf-8");
        return localPath;
    } catch {
        return join(homedir(), ".fyuobot", "config.json");
    }
}

function loadMCPServers(): MCPServerConfig[] {
    const configPath = resolveConfigPath();
    try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as { mcpServers?: MCPServerConfig[] };
        console.log(`[MCP] 加载配置: ${configPath}`);
        return config.mcpServers ?? [];
    } catch {
        console.warn(`⚠ 未找到 MCP 配置文件: ${configPath}，跳过远程工具加载`);
        return [];
    }
}

const MCP_SERVERS = loadMCPServers();

// ── Claude Code 风格：初始单次绘制 Titile ───────────────────
function printSystemHeader(toolCount: number) {
    const LOGO_LINES = [
        "  ██  █  █ █  █  ██  █     ██   █  ",
        "  █   █  █ █  █ █  █ ███  █  █ ███ ",
        "  ███  ███ █  █ █  █ █  █ █  █  █  ",
        "  █      █  ██   ██  ███   ██   ██ ",
        ""
    ];

    console.log("     ");
    
    // 使用纯高效 ANSI 转义序列渲染大 Logo 及其阴影
    for (let y = 0; y < LOGO_LINES.length; y++) {
        const row = LOGO_LINES[y];
        let line = c.cyan(" │ ");
        let hasContent = false;
        
        for (let x = 0; x < 35; x++) {
            const char = row[x];
            const isMain = char === "█";
            const isShadow = y > 0 && x > 0 && LOGO_LINES[y - 1]?.[x - 1] === "█";
            
            if (isMain) {
                line += c.bgWhite(" "); // 白色背景实体
                hasContent = true;
            } else if (isShadow) {
                line += c.gray256("█");// 暗灰阴影
                hasContent = true;
            } else {
                line += " ";
            }
        }
        line += "     ";
        //line += c.cyan(" | ");
        if (hasContent || y < LOGO_LINES.length - 1) {
            console.log(line);
        }
    }
    
    // 打印当前的系统静态环境信息
    console.log("     ");
    
    console.log(`  ${c.bold("📁 当前目录:")} ${process.cwd()}`);
    console.log(`  ${c.dim(`💡 系统状态: 已加载 ${toolCount} 个工具`)}`);
}

// ── Bootstrap ────────────────────────────────────────────
async function bootstrap() {
    let unmountUI: () => void;
    let mcpManager: MCPManager | undefined;

    try {
        // 0. 初始化历史记录管理器（SQLite + 创建会话）
        HistoryManager.init();

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

        // 【核心修改】在挂载交互 UI 之前，单次冷启动打印环境信息和 Logo，化身终端滚动历史
        printSystemHeader(registry.size);

        // 4. 挂载 React Ink UI
        const { unmount } = render(
            <AgentUI agent={agent} />,
        );
        unmountUI = unmount;

        // 5. 退出清理
        const cleanup = async () => {
            if (unmountUI) unmountUI();
            process.stdout.write(c.showCursor);
            if (mcpManager) {
                await mcpManager.disconnect().catch(err => console.error("Disconnect error:", err));
            }
            process.exit(0);
        };

        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
    } catch (error) {
        console.error("\n❌ 引擎启动遭受致命打击:", error);
        if (mcpManager) {
            await mcpManager.disconnect().catch(() => {});
        }
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}