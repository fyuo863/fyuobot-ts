import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
    getAgentPathCandidates,
    resolveProjectAgentPath,
} from "./agent-paths.js";

export interface AppConfig {
    debug?: {
        promptCache?: boolean;
        fileLogging?: boolean;
        logToolResults?: boolean;
    };
    toolOutput?: {
        enabled?: boolean;
    };
    defaultModel?: string;
    visionFallbackModel?: string;
    subAgent?: {
        defaultModel?: string;
        visionModel?: string;
    };
    models?: Record<
        string,
        {
            model?: string;
            baseURL?: string;
            apiKey?: string;
            provider?: string;
            description?: string;
            capabilities?: {
                vision?: boolean;
                toolUse?: boolean;
                streaming?: boolean;
            };
        }
    >;
}

const warnedPaths = new Set<string>();
let cachedLogFilePath: string | undefined;

function getConfigCandidates(): string[] {
    return getAgentPathCandidates("config.json");
}

export function resolveAppConfigPath(): string | undefined {
    return getConfigCandidates().find((candidate) => existsSync(candidate));
}

export function loadAppConfig(): { path?: string; config: AppConfig } {
    const configPath = resolveAppConfigPath();
    if (!configPath) return { config: {} };

    try {
        const raw = readFileSync(configPath, "utf-8");
        return {
            path: configPath,
            config: JSON.parse(raw) as AppConfig,
        };
    } catch (error) {
        if (!warnedPaths.has(configPath)) {
            warnedPaths.add(configPath);
            console.warn(
                `[config] failed to parse ${configPath}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return {
            path: configPath,
            config: {},
        };
    }
}

export function isPromptCacheDebugEnabled(): boolean {
    return loadAppConfig().config.debug?.promptCache === true;
}

export function isFileLoggingEnabled(): boolean {
    return loadAppConfig().config.debug?.fileLogging === true;
}

export function shouldLogToolResults(): boolean {
    return loadAppConfig().config.debug?.logToolResults !== false;
}

export function isToolOutputEnabled(): boolean {
    return loadAppConfig().config.toolOutput?.enabled !== false;
}

export function logPromptDebug(
    scope: string,
    payload: Record<string, unknown>,
): void {
    if (!isPromptCacheDebugEnabled()) return;
    appendDebugLog("prompt-debug", scope, payload);
}

export function appendRuntimeLog(
    scope: string,
    payload: Record<string, unknown>,
): void {
    if (!isFileLoggingEnabled()) return;
    appendDebugLog("runtime", scope, payload);
}

export function appendPromptCacheLog(
    scope: string,
    payload: Record<string, unknown>,
): void {
    if (!isPromptCacheDebugEnabled()) return;
    appendDebugLog("prompt-cache", scope, payload);
}

export function hashDebugValue(value: unknown): string {
    return createHash("sha1")
        .update(stableStringify(value))
        .digest("hex")
        .slice(0, 12);
}

export function truncateForLog(value: string, maxLength = 4000): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}\n... [truncated ${value.length - maxLength} chars]`;
}

function appendDebugLog(
    channel: string,
    scope: string,
    payload: Record<string, unknown>,
): void {
    const filePath = getLogFilePath();
    if (!filePath) return;

    const record = {
        ts: new Date().toISOString(),
        pid: process.pid,
        channel,
        scope,
        payload: summarizeForLog(payload),
    };

    try {
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
    } catch (error) {
        const key = `${filePath}:append`;
        if (!warnedPaths.has(key)) {
            warnedPaths.add(key);
            console.warn(
                `[log] failed to append ${filePath}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

function summarizeForLog(value: unknown, depth = 0): unknown {
    if (typeof value === "string") {
        return summarizeString(value);
    }

    if (
        value === null ||
        value === undefined ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value;
    }

    if (Array.isArray(value)) {
        if (depth >= 3) {
            return {
                type: "array",
                length: value.length,
                hash: hashDebugValue(value),
            };
        }

        return {
            type: "array",
            length: value.length,
            hash: hashDebugValue(value),
            items: value.slice(0, 5).map((item) => summarizeForLog(item, depth + 1)),
        };
    }

    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);

        if (depth >= 3) {
            return {
                type: "object",
                keyCount: keys.length,
                hash: hashDebugValue(record),
            };
        }

        const summarized: Record<string, unknown> = {};
        for (const key of keys.slice(0, 20)) {
            summarized[key] = summarizeForLog(record[key], depth + 1);
        }
        if (keys.length > 20) {
            summarized.__truncated_keys__ = keys.length - 20;
        }

        return summarized;
    }

    return String(value);
}

function summarizeString(value: string): unknown {
    const normalized = value.replace(/\r/g, "");
    const preview = truncateForLog(normalized, 400);
    return {
        type: "string",
        length: value.length,
        hash: hashDebugValue(value),
        preview,
    };
}

function getLogFilePath(): string | undefined {
    if (cachedLogFilePath) return cachedLogFilePath;

    const logDir = resolveProjectAgentPath("log");
    try {
        mkdirSync(logDir, { recursive: true });
        cachedLogFilePath = join(logDir, `${buildSessionLogName()}.jsonl`);
        return cachedLogFilePath;
    } catch (error) {
        const key = `${logDir}:mkdir`;
        if (!warnedPaths.has(key)) {
            warnedPaths.add(key);
            console.warn(
                `[log] failed to initialize ${logDir}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return undefined;
    }
}

function buildSessionLogName(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `agent-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${process.pid}`;
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
