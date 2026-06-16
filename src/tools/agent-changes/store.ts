import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveProjectAgentPath, resolveProjectRoot } from "../../config/agent-paths.js";

export type AgentChangeAction = "write" | "append" | "insert" | "replace" | "delete";
export type AgentChangeStatus = "applied" | "reverted" | "conflict";

export interface AgentChangeEntry {
    id: string;
    turnId?: string;
    toolCallId?: string;
    toolName: string;
    action: AgentChangeAction;
    path: string;
    absolutePath: string;
    createdAt: number;
    summary: string;
    beforeHash: string;
    afterHash: string;
    beforeExists: boolean;
    afterExists: boolean;
    beforeSnapshotPath: string;
    afterSnapshotPath: string;
    revertedAt?: number;
    revertSummary?: string;
    status: AgentChangeStatus;
}

interface AgentChangeIndex {
    entries: AgentChangeEntry[];
}

interface RecordAgentChangeInput {
    action: AgentChangeAction;
    path: string;
    absolutePath: string;
    summary: string;
    beforeContent: string;
    afterContent: string;
    beforeExists: boolean;
    afterExists: boolean;
    turnId?: string;
    toolCallId?: string;
    toolName?: string;
}

interface UndoAgentChangeInput {
    id?: string;
}

export interface UndoAgentChangeResult {
    ok: boolean;
    entry?: AgentChangeEntry;
    message: string;
}

export interface UndoAgentTurnResult {
    ok: boolean;
    turnId: string;
    message: string;
    revertedEntries: AgentChangeEntry[];
    conflictEntry?: AgentChangeEntry;
}

const INDEX_FILENAME = "index.json";

function sha256(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
}

function createEntryId(): string {
    return `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function agentChangesRoot(): string {
    return resolveProjectAgentPath("agent_changes");
}

function indexPath(): string {
    return join(agentChangesRoot(), INDEX_FILENAME);
}

function snapshotsRoot(): string {
    return join(agentChangesRoot(), "snapshots");
}

function snapshotPath(hash: string): string {
    return join(snapshotsRoot(), `${hash}.txt`);
}

async function ensureStore(): Promise<void> {
    await mkdir(snapshotsRoot(), { recursive: true });
}

async function readIndex(): Promise<AgentChangeIndex> {
    const path = indexPath();
    if (!existsSync(path)) {
        return { entries: [] };
    }

    try {
        const raw = await readFile(path, "utf-8");
        const parsed = JSON.parse(raw) as AgentChangeIndex;
        return {
            entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        };
    } catch {
        return { entries: [] };
    }
}

async function writeIndex(index: AgentChangeIndex): Promise<void> {
    await ensureStore();
    await writeFile(indexPath(), JSON.stringify(index, null, 2) + "\n", "utf-8");
}

async function persistSnapshot(hash: string, content: string): Promise<string> {
    const path = snapshotPath(hash);
    if (!existsSync(path)) {
        await ensureStore();
        await writeFile(path, content, "utf-8");
    }
    return path;
}

async function restoreFileFromEntry(entry: AgentChangeEntry): Promise<UndoAgentChangeResult> {
    let currentContent = "";
    let currentExists = false;

    if (existsSync(entry.absolutePath)) {
        const info = await stat(entry.absolutePath);
        if (!info.isFile()) {
            return {
                ok: false,
                entry,
                message: `无法撤回：目标不是普通文件 ${entry.path}`,
            };
        }
        currentContent = await readFile(entry.absolutePath, "utf-8");
        currentExists = true;
    }

    const currentHash = sha256(currentContent);
    const expectedHash = entry.afterHash;
    if ((currentExists !== entry.afterExists) || currentHash !== expectedHash) {
        return {
            ok: false,
            entry: {
                ...entry,
                status: "conflict",
            },
            message: `无法安全撤回：${entry.path} 已被后续修改，请先检查当前内容。`,
        };
    }

    if (!entry.beforeExists) {
        if (existsSync(entry.absolutePath)) {
            await import("node:fs/promises").then(({ rm }) =>
                rm(entry.absolutePath, { force: false }),
            );
        }
    } else {
        const beforeContent = await readFile(entry.beforeSnapshotPath, "utf-8");
        await mkdir(dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, beforeContent, "utf-8");
    }

    return {
        ok: true,
        entry: {
            ...entry,
            status: "reverted",
            revertedAt: Date.now(),
            revertSummary: `已撤回 ${entry.path}`,
        },
        message: `已撤回 agent 改动：${entry.path}`,
    };
}

export async function recordAgentChange(
    input: RecordAgentChangeInput,
): Promise<AgentChangeEntry> {
    const beforeHash = sha256(input.beforeContent);
    const afterHash = sha256(input.afterContent);
    const beforeSnapshotPath = await persistSnapshot(beforeHash, input.beforeContent);
    const afterSnapshotPath = await persistSnapshot(afterHash, input.afterContent);
    const index = await readIndex();

    const entry: AgentChangeEntry = {
        id: createEntryId(),
        toolName: input.toolName ?? "file_operator",
        action: input.action,
        path: input.path,
        absolutePath: input.absolutePath,
        createdAt: Date.now(),
        summary: input.summary,
        beforeHash,
        afterHash,
        beforeExists: input.beforeExists,
        afterExists: input.afterExists,
        beforeSnapshotPath,
        afterSnapshotPath,
        status: "applied",
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    };

    index.entries.push(entry);
    await writeIndex(index);
    return entry;
}

export async function listAgentChanges(): Promise<AgentChangeEntry[]> {
    const index = await readIndex();
    return [...index.entries].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAgentChange(id: string): Promise<AgentChangeEntry | null> {
    const index = await readIndex();
    return index.entries.find((entry) => entry.id === id) ?? null;
}

export async function listAgentChangesByTurn(
    turnId: string,
): Promise<AgentChangeEntry[]> {
    const index = await readIndex();
    return index.entries
        .filter((entry) => entry.turnId === turnId)
        .sort((a, b) => b.createdAt - a.createdAt);
}

export async function undoAgentChange(
    input: UndoAgentChangeInput = {},
): Promise<UndoAgentChangeResult> {
    const index = await readIndex();
    const target = input.id
        ? index.entries.find((entry) => entry.id === input.id)
        : [...index.entries]
              .sort((a, b) => b.createdAt - a.createdAt)
              .find((entry) => entry.status === "applied");

    if (!target) {
        return {
            ok: false,
            message: input.id
                ? `未找到改动记录: ${input.id}`
                : "没有可撤回的 agent 文件改动。",
        };
    }

    if (target.status !== "applied") {
        return {
            ok: false,
            entry: target,
            message: `该改动当前状态为 ${target.status}，不能重复撤回。`,
        };
    }

    const result = await restoreFileFromEntry(target);
    const updatedEntry = result.entry;

    if (updatedEntry) {
        index.entries = index.entries.map((entry) =>
            entry.id === updatedEntry.id ? updatedEntry : entry,
        );
        await writeIndex(index);
    }

    return result;
}

export async function undoAgentChangesForTurn(
    turnId: string,
): Promise<UndoAgentTurnResult> {
    const index = await readIndex();
    const turnEntries = index.entries
        .filter((entry) => entry.turnId === turnId)
        .sort((a, b) => b.createdAt - a.createdAt);

    if (turnEntries.length === 0) {
        return {
            ok: false,
            turnId,
            revertedEntries: [],
            message: `未找到 turn=${turnId} 的 agent 改动记录。`,
        };
    }

    const pendingEntries = turnEntries.filter((entry) => entry.status === "applied");
    if (pendingEntries.length === 0) {
        return {
            ok: false,
            turnId,
            revertedEntries: [],
            message: `turn=${turnId} 没有可撤回的 agent 改动。`,
        };
    }

    const updatedEntries = [...index.entries];
    const revertedEntries: AgentChangeEntry[] = [];
    let conflictEntry: AgentChangeEntry | undefined;

    for (const entry of pendingEntries) {
        const result = await restoreFileFromEntry(entry);
        const nextEntry = result.entry;

        if (nextEntry) {
            const targetIndex = updatedEntries.findIndex(
                (item) => item.id === nextEntry.id,
            );
            if (targetIndex >= 0) {
                updatedEntries[targetIndex] = nextEntry;
            }
        }

        if (!result.ok) {
            conflictEntry = nextEntry;
            break;
        }

        if (nextEntry) {
            revertedEntries.push(nextEntry);
        }
    }

    index.entries = updatedEntries;
    await writeIndex(index);

    if (conflictEntry) {
        return {
            ok: false,
            turnId,
            revertedEntries,
            conflictEntry,
            message:
                revertedEntries.length > 0
                    ? `turn=${turnId} 已撤回 ${revertedEntries.length} 条改动，但在 ${conflictEntry.path} 处检测到冲突并停止。`
                    : `turn=${turnId} 撤回失败：${conflictEntry.path} 已被后续修改。`,
        };
    }

    return {
        ok: true,
        turnId,
        revertedEntries,
        message: `已按 turn 撤回 ${revertedEntries.length} 条 agent 改动：${turnId}`,
    };
}

export function getAgentChangesRootPath(): string {
    return agentChangesRoot();
}

export function getAgentChangesProjectRoot(): string {
    return resolveProjectRoot();
}
