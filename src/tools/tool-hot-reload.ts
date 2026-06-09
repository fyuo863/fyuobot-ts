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

export interface TriggerToolHotReloadResult {
    changed: boolean;
    reason: string;
    message: string;
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
    let pendingSchemaHash: string | undefined;

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
            const nextSchemaHash = getRegistrySchemaHash(loaded.registry);
            const activeSchemaHash = getRegistrySchemaHash(options.agent.registry);

            if (nextSchemaHash === activeSchemaHash) {
                pendingSchemaHash = undefined;
                options.agent.clearPendingRegistry(
                    `tool schema unchanged after ${reason}`,
                );
                return;
            }

            if (nextSchemaHash === pendingSchemaHash) {
                return;
            }

            pendingSchemaHash = nextSchemaHash;
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

export async function triggerToolHotReload(
    options: ToolHotReloadOptions,
    reason = "manual hot reload trigger",
): Promise<TriggerToolHotReloadResult> {
    try {
        const loadOptions = {
            cacheBust: String(Date.now()),
            ...(options.mcpTools ? { mcpTools: options.mcpTools } : {}),
        };
        const loaded = await loadToolRegistry(loadOptions);
        const nextSchemaHash = getRegistrySchemaHash(loaded.registry);
        const activeSchemaHash = getRegistrySchemaHash(options.agent.registry);

        if (nextSchemaHash === activeSchemaHash) {
            options.agent.clearPendingRegistry(
                `tool schema unchanged after ${reason}`,
            );
            return {
                changed: false,
                reason,
                message: "工具 schema 无变化，无需热重载。",
            };
        }

        options.agent.setPendingRegistry(loaded.registry, reason);
        return {
            changed: true,
            reason,
            message: `已准备热重载：${loaded.registry.size} 个工具将在下一轮生效。`,
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`热重载构建失败: ${message}`);
    }
}

function getRegistrySchemaHash(registry: Agent["registry"]): string {
    return stableStringify(registry.toOpenAITools());
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
}

function shouldIgnore(filename: string): boolean {
    if (!filename) return false;
    const normalized = filename.replaceAll("\\", "/");
    return normalized
        .split("/")
        .some((part) => IGNORED_PARTS.has(part) || part.startsWith("."));
}
