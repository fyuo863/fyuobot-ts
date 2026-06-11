import React from "react";
import { render } from "ink";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import process from "process";

import type { BaseTool } from "../tools/basetool.js";
import { AgentRuntime } from "../agent/runtime.js";
import { CommandRegistry } from "../slash/registry.js";
import {
    MCPManager,
    normalizeMCPConfig,
    type MCPServerConfig,
} from "../mcp/mcp.js";
import { HistoryManager } from "../memory/history-manager.js";
import { AgentUI } from "./ui.js";
import { c } from "./colors.js";
import { printSystemHeader } from "./header.js";
import { AgentEventType } from "../agent/events.js";
import { pushPendingResult } from "../tools/sub-agent-tool.js";
import { loadToolRegistry } from "../tools/tool-loader.js";
import {
    startToolHotReload,
    type ToolHotReloadHandle,
} from "../tools/tool-hot-reload.js";
import {
    getAgentPathCandidates,
    resolveExistingAgentPath,
    resolveProjectRoot,
} from "../config/agent-paths.js";

function resolveMCPPath(): string {
    return (
        resolveExistingAgentPath("mcp.json") ??
        getAgentPathCandidates("mcp.json")[0]!
    );
}

function loadMCPServers(): MCPServerConfig[] {
    const configPath = resolveMCPPath();
    try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as unknown;
        console.log(`[MCP] loaded config: ${configPath}`);
        return normalizeMCPConfig(config);
    } catch (error) {
        const reason =
            error instanceof Error ? error.message : "unknown read/parse error";
        console.warn(
            `[MCP] config unavailable: ${configPath} (${reason}); skipping MCP tools`,
        );
        return [];
    }
}

const MCP_SERVERS = loadMCPServers();

async function bootstrap() {
    let unmountUI: (() => void) | undefined;
    let mcpManager: MCPManager | undefined;
    let runtime: AgentRuntime | undefined;
    let hotReload: ToolHotReloadHandle | undefined;

    try {
        const projectRoot = resolveProjectRoot();
        HistoryManager.init(projectRoot);

        mcpManager = new MCPManager();
        let mcpTools: BaseTool[] = [];
        if (MCP_SERVERS.length > 0) {
            await mcpManager.connect(MCP_SERVERS);
            mcpTools = await mcpManager.discoverAllTools();
            console.log(`[MCP] registered ${mcpTools.length} remote tools`);
        }

        const loadedTools = await loadToolRegistry({
            installExternalDependencies: true,
            mcpTools,
        });
        const registry = loadedTools.registry;
        if (loadedTools.externalCount > 0) {
            console.log(
                `[tools] loaded ${loadedTools.externalCount} external tools`,
            );
        }
        if (loadedTools.skillCount > 0) {
            console.log(`[tools] loaded ${loadedTools.skillCount} skills`);
        }

        const cmdRegistry = new CommandRegistry();
        const slashCount = await cmdRegistry.discoverAndRegister(
            new URL("../slash/commands", import.meta.url),
        );

        let extSlashCount = 0;
        const externalSlashDirs = getAgentPathCandidates("slash");
        for (const dir of externalSlashDirs) {
            const extRegistry =
                await CommandRegistry.discoverFromDirectory(dir);
            extSlashCount += cmdRegistry.mergeFrom(extRegistry);
        }

        const totalSlash = slashCount + extSlashCount;
        if (totalSlash > 0) {
            console.log(
                `[slash] loaded ${totalSlash} commands` +
                    (extSlashCount > 0
                        ? ` (built-in ${slashCount}, external ${extSlashCount})`
                        : ""),
            );
        }

        runtime = AgentRuntime.createDefault(registry);
        const agent = runtime.getDefault();
        const loop = runtime.getEventLoop();

        runtime.start();
        console.log("[event] event loop started");

        loop.on(AgentEventType.USER_QUERY, (event) => {
            console.log(
                `[passive] received external query: ${event.query.slice(0, 80)}`,
            );
            agent
                .runTask(event.query)
                .then((result) => {
                    console.log(
                        `[passive] response completed: ${result.slice(0, 80)}`,
                    );
                })
                .catch((err) => {
                    console.warn(
                        "[passive] response failed:",
                        err instanceof Error ? err.message : String(err),
                    );
                });
        });
        console.log("[event] passive query handler registered");

        loop.on(AgentEventType.SUB_AGENT_RESULT_READY, (event) => {
            if (event.type !== AgentEventType.SUB_AGENT_RESULT_READY) return;
            pushPendingResult({
                subAgentId: event.subAgentId,
                task: event.task,
                finalContent: event.finalContent,
                elapsedMs: event.elapsedMs,
                completedAt: Date.now(),
            });
            console.log(
                `[a2a] sub-agent "${event.subAgentId}" result queued for main agent`,
            );
        });

        loop.on(AgentEventType.SUB_AGENT_START, (event) => {
            if (event.type !== AgentEventType.SUB_AGENT_START) return;
            console.log(
                `[a2a] sub-agent "${event.subAgentId}" started (model: ${event.model})`,
            );
        });
        loop.on(AgentEventType.SUB_AGENT_COMPLETE, (event) => {
            if (event.type !== AgentEventType.SUB_AGENT_COMPLETE) return;
            console.log(
                `[a2a] sub-agent "${event.subAgentId}" completed ` +
                    `(LLM: ${event.totalLlmCalls}, tools: ${event.totalToolCalls}, ` +
                    `elapsed: ${(event.elapsedMs / 1000).toFixed(1)}s)`,
            );
        });
        loop.on(AgentEventType.SUB_AGENT_ERROR, (event) => {
            if (event.type !== AgentEventType.SUB_AGENT_ERROR) return;
            console.log(
                `[a2a] sub-agent "${event.subAgentId}" failed: ${event.error}`,
            );
        });
        console.log("[event] A2A handlers registered");

        await registry.initAll(agent);
        hotReload = startToolHotReload({ agent, mcpTools });

        printSystemHeader(registry.size, totalSlash);

        const { unmount } = render(
            <AgentUI
                agent={agent}
                commandRegistry={cmdRegistry}
                loop={loop}
            />,
        );
        unmountUI = unmount;

        const cleanup = async () => {
            hotReload?.close();
            if (unmountUI) unmountUI();
            process.stdout.write(c.showCursor);
            if (runtime) {
                await runtime.stop().catch((err) =>
                    console.error("Event loop stop error:", err),
                );
            }
            await agent.registry
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

        process.on("SIGINT", () => {
            void cleanup();
        });
        process.on("SIGTERM", cleanup);
    } catch (error) {
        console.error("\nFatal startup error:", error);
        hotReload?.close();
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
