// src/tui/index.tsx
import React from "react";
import { render } from "ink";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import process from "process";

import { ToolRegistry } from "../tools/basetool.js";
import { AgentRuntime } from "../agent/runtime.js";
import { CommandRegistry } from "../slash/registry.js";
import { MCPManager, type MCPServerConfig } from "../mcp/mcp.js";
import { HistoryManager } from "../memory/history-manager.js";
import {
    loadSkillsFromDirectory,
    registerSkillsToRegistry,
} from "../tools/skill/skill-loader.js";
import { AgentUI } from "./ui.js";
import { c } from "./colors.js"; // 引入你封装的模块
import { printSystemHeader } from "./header.js";

import { homedir } from "os";

/**
 * MCP 配置文件查找顺序：
 *   1. 项目本地 .fyuobot/mcp.json（优先）
 *   2. 用户 Home 目录 ~/.fyuobot/mcp.json（兜底）
 */
function resolveMCPPath(): string {
    const localPath = join(process.cwd(), ".fyuobot", "mcp.json");
    try {
        readFileSync(localPath, "utf-8");
        return localPath;
    } catch {
        return join(homedir(), ".fyuobot", "mcp.json");
    }
}

function loadMCPServers(): MCPServerConfig[] {
    const configPath = resolveMCPPath();
    try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as {
            mcpServers?: MCPServerConfig[];
        };
        console.log(`[MCP] 加载配置: ${configPath}`);
        return config.mcpServers ?? [];
    } catch {
        console.warn(
            `⚠ 未找到 MCP 配置文件: ${configPath}，跳过远程工具加载`,
        );
        return [];
    }
}

const MCP_SERVERS = loadMCPServers();

// ── Bootstrap ────────────────────────────────────────────
async function bootstrap() {
    let unmountUI: () => void;
    let mcpManager: MCPManager | undefined;
    let runtime: AgentRuntime | undefined;

    try {
        // 0. 初始化历史记录管理器（SQLite + 创建会话）
        HistoryManager.init();

        // 0.5 检查并安装外挂工具依赖
        {
            const externalDirs: {
                dir: string;
                projectRoot?: string;
            }[] = [
                {
                    dir: join(process.cwd(), ".fyuobot", "tools"),
                    projectRoot: process.cwd(),
                },
                { dir: join(homedir(), ".fyuobot", "tools") },
            ];
            for (const { dir, projectRoot } of externalDirs) {
                if (!existsSync(dir)) continue;
                const installed = await ToolRegistry.installDependencies(
                    dir,
                    projectRoot,
                );
                if (installed > 0) {
                    console.log(
                        `📦 外挂工具依赖: 已处理 ${installed} 个`,
                    );
                }
            }
        }

        // 1. 自动扫描本地工具目录
        const registry = await ToolRegistry.discoverAndRegister(
            new URL("../tools", import.meta.url),
        );

        // 1b. 自动扫描外挂工具目录（项目本地 + 用户全局）
        const externalDirs = [
            join(process.cwd(), ".fyuobot", "tools"),
            join(homedir(), ".fyuobot", "tools"),
        ];
        let externalCount = 0;
        for (const dir of externalDirs) {
            if (!existsSync(dir)) continue;
            const extRegistry = await ToolRegistry.discoverFromFolders(
                pathToFileURL(dir) as unknown as URL,
            );
            const merged = registry.mergeFrom(extRegistry);
            externalCount += merged;
        }
        if (externalCount > 0) {
            console.log(
                `🧩 外挂工具: 已加载 ${externalCount} 个（来自 .fyuobot/tools/）`,
            );
        }

        // 1c. 加载技能工具（内置 → 项目本地 → 用户全局，同名内置优先）
        const skillDirs = [
            // 内置技能（随项目分发）
            join(
                dirname(fileURLToPath(import.meta.url)),
                "..",
                "tools",
                "skill",
                "builtin",
            ),
            // 外挂技能（项目本地 > 用户全局）
            join(process.cwd(), ".fyuobot", "skills"),
            join(homedir(), ".fyuobot", "skills"),
        ];
        let totalSkillCount = 0;
        for (const dir of skillDirs) {
            const skillTools = await loadSkillsFromDirectory(dir);
            const registered = registerSkillsToRegistry(
                registry,
                skillTools,
            );
            totalSkillCount += registered;
        }
        if (totalSkillCount > 0) {
            console.log(
                `📋 技能工具: 已加载 ${totalSkillCount} 个`,
            );
        }

        // 2. 连接 MCP 服务器，发现远程工具并注入
        mcpManager = new MCPManager();
        if (MCP_SERVERS.length > 0) {
            await mcpManager.connect(MCP_SERVERS);
            const mcpTools = await mcpManager.discoverAllTools();
            for (const tool of mcpTools) {
                registry.register(tool);
            }
            console.log(
                `🔌 MCP: 已注入 ${mcpTools.length} 个远程工具`,
            );
        }

        // 3. 初始化斜杠命令注册中心（自动发现 src/slash/commands/ 下的命令）
        const cmdRegistry = new CommandRegistry();
        const slashCount = await cmdRegistry.discoverAndRegister(
            new URL("../slash/commands", import.meta.url),
        );

        // 3b. 自动发现外挂斜杠命令（项目本地 + 用户全局）
        let extSlashCount = 0;
        const externalSlashDirs = [
            join(process.cwd(), ".fyuobot", "slash"),
            join(homedir(), ".fyuobot", "slash"),
        ];
        for (const dir of externalSlashDirs) {
            const extRegistry =
                await CommandRegistry.discoverFromDirectory(dir);
            const merged = cmdRegistry.mergeFrom(extRegistry);
            extSlashCount += merged;
        }

        const totalSlash = slashCount + extSlashCount;
        if (totalSlash > 0) {
            const parts: string[] = [`已加载 ${totalSlash} 个`];
            if (extSlashCount > 0)
                parts.push(
                    `（内置 ${slashCount} + 外挂 ${extSlashCount}）`,
                );
            console.log(`⌨  斜杠命令: ${parts.join("")}`);
        }

        // 4. 创建 Agent 运行时（包含 MessageQueue + EventLoop + Agent）
        runtime = AgentRuntime.createDefault(registry);
        const agent = runtime.getDefault();
        const loop = runtime.getEventLoop();

        // 4.5. 启动事件循环
        runtime.start();
        console.log("[event] 事件循环已启动");

        // 5. 通知所有工具：Agent 已就绪（工具可通过 onInit 钩子启动伴随服务）
        await registry.initAll(agent);

        // 【核心修改】在挂载交互 UI 之前，单次冷启动打印环境信息和 Logo，化身终端滚动历史
        printSystemHeader(registry.size, totalSlash);

        // 6. 挂载 React Ink UI
        const { unmount } = render(
            <AgentUI
                agent={agent}
                commandRegistry={cmdRegistry}
                loop={loop}
            />,
        );
        unmountUI = unmount;

        // 7. 退出清理
        const cleanup = async () => {
            if (unmountUI) unmountUI();
            process.stdout.write(c.showCursor);
            // 优雅关闭事件循环
            if (runtime) {
                await runtime.stop().catch((err) =>
                    console.error("Event loop stop error:", err),
                );
            }
            // 通知所有工具释放资源（实现了 onDestroy 的会自行清理）
            await registry
                .destroyAll()
                .catch((err) => console.error("Tool cleanup error:", err));
            if (mcpManager) {
                await mcpManager
                    .disconnect()
                    .catch((err) =>
                        console.error("Disconnect error:", err),
                    );
            }
            process.exit(0);
        };

        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
    } catch (error) {
        console.error("\n❌ 引擎启动遭受致命打击:", error);
        if (runtime) {
            await runtime.stop().catch(() => {});
        }
        if (mcpManager) {
            await mcpManager.disconnect().catch(() => {});
        }
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}
