import { existsSync, watch } from "fs";
import type { FSWatcher } from "fs";
import type { Agent } from "../agent/agent.js";
import type { BaseTool } from "./basetool.js";
import { getToolWatchDirs, loadToolRegistry } from "./tool-loader.js";

export interface ToolHotReloadOptions {
    agent: Agent;
    mcpTools?: BaseTool[];
    debounceMs?: number;
}

export interface ToolHotReloadHandle {
    close(): void;
}

const IGNORED_PARTS = new Set([
    "node_modules",
    "dist",
    "build",
    ".git",
    ".codegraph",
    "_test",
]);

export function startToolHotReload(
    options: ToolHotReloadOptions,
): ToolHotReloadHandle {
    const debounceMs = options.debounceMs ?? 800;
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let building = false;
    let queuedReason: string | undefined;

    const schedule = (reason: string) => {
        if (closed) return;
        queuedReason = reason;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            void rebuild();
        }, debounceMs);
    };

    const rebuild = async (): Promise<void> => {
        if (closed) return;
        if (building) {
            if (queuedReason) schedule(queuedReason);
            return;
        }

        const reason = queuedReason ?? "tool file change";
        queuedReason = undefined;
        building = true;

        try {
            const loadOptions = {
                cacheBust: String(Date.now()),
                ...(options.mcpTools ? { mcpTools: options.mcpTools } : {}),
            };
            const loaded = await loadToolRegistry(loadOptions);
            options.agent.setPendingRegistry(loaded.registry, reason);
        } catch (e) {
            console.warn(
                "[tools] hot update build failed:",
                e instanceof Error ? e.message : String(e),
            );
        } finally {
            building = false;
            if (queuedReason && !closed) schedule(queuedReason);
        }
    };

    for (const dir of getToolWatchDirs()) {
        if (!existsSync(dir)) continue;

        try {
            const watcher = watch(
                dir,
                { recursive: true },
                (_eventType, filename) => {
                    const name = filename?.toString() ?? "";
                    if (shouldIgnore(name)) return;
                    schedule(name || dir);
                },
            );
            watcher.on("error", (err) => {
                console.warn(`[tools] hot reload watcher error: ${err.message}`);
            });
            watchers.push(watcher);
        } catch (e) {
            console.warn(
                `[tools] cannot watch ${dir}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }

    if (watchers.length > 0) {
        console.log(`[tools] hot reload watching ${watchers.length} directories`);
    }

    return {
        close() {
            closed = true;
            if (timer) clearTimeout(timer);
            for (const watcher of watchers) {
                watcher.close();
            }
        },
    };
}

function shouldIgnore(filename: string): boolean {
    if (!filename) return false;
    const normalized = filename.replaceAll("\\", "/");
    return normalized
        .split("/")
        .some((part) => IGNORED_PARTS.has(part) || part.startsWith("."));
}
