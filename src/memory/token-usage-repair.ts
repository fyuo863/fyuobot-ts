import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../config/agent-paths.js";
import { HistoryManager } from "./history-manager.js";

interface RepairOptions {
    projectRoot?: string;
    apply?: boolean;
    maxTimeDeltaSeconds?: number;
}

interface HistoryTurnRow {
    id: number;
    timestamp: number;
    date: string;
    time_24h: string;
    ask: string;
    answer: string;
    turn_input_tokens: number;
    turn_output_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
}

interface RuntimeTurnAggregate {
    turnId: string;
    timestamp: number;
    answerHash: string | undefined;
    answerPreview: string | undefined;
    totalLlmCalls?: number;
    parentTurnId: string | undefined;
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    logFile: string;
}

interface RepairMatch {
    turnRowId: number;
    runtimeTurnId: string;
    before: TokenNumbers;
    after: TokenNumbers;
    timestampDeltaSeconds: number;
    date: string;
    time24h: string;
    logFile: string;
    totalLlmCalls: number;
    answerHash: string;
    answerPreview: string;
}

interface TokenNumbers {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
}

interface UnmatchedHistoryTurn {
    turnRowId: number;
    date: string;
    time24h: string;
    reason: string;
    answerHash: string;
    answerPreview: string;
}

interface UnmatchedRuntimeTurn {
    runtimeTurnId: string;
    timestamp: number;
    reason: string;
    answerHash: string | undefined;
    answerPreview: string | undefined;
    logFile: string;
    totalLlmCalls: number;
}

export interface TokenUsageRepairReport {
    projectRoot: string;
    databasePath: string;
    logDir: string;
    apply: boolean;
    maxTimeDeltaSeconds: number;
    scannedLogFiles: number;
    runtimeTurnCount: number;
    candidateHistoryTurnCount: number;
    matchedTurnCount: number;
    updatedTurnCount: number;
    skippedAlreadyCorrectCount: number;
    unmatchedHistoryTurns: UnmatchedHistoryTurn[];
    unmatchedRuntimeTurns: UnmatchedRuntimeTurn[];
    repairedTurns: RepairMatch[];
    auditPath: string;
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

function hashDebugValue(value: unknown): string {
    return createHash("sha1")
        .update(stableStringify(value))
        .digest("hex")
        .slice(0, 12);
}

function normalizeTokenNumbers(source: Partial<TokenNumbers>): TokenNumbers {
    return {
        inputTokens: Math.max(0, Math.round(source.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.round(source.outputTokens ?? 0)),
        cacheHitTokens: Math.max(0, Math.round(source.cacheHitTokens ?? 0)),
        cacheMissTokens: Math.max(0, Math.round(source.cacheMissTokens ?? 0)),
    };
}

function sameTokens(a: TokenNumbers, b: TokenNumbers): boolean {
    return (
        a.inputTokens === b.inputTokens &&
        a.outputTokens === b.outputTokens &&
        a.cacheHitTokens === b.cacheHitTokens &&
        a.cacheMissTokens === b.cacheMissTokens
    );
}

function getStringPreview(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    return typeof record.preview === "string" ? record.preview : undefined;
}

function getHashPreview(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    return typeof record.hash === "string" ? record.hash : undefined;
}

function getTurnIdFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    return getStringPreview(record.turnId);
}

function getAnswerHashFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    return getHashPreview(record.finalContent);
}

function getAnswerPreviewFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    return getStringPreview(record.finalContent);
}

function readRuntimeTurnAggregates(logDir: string): {
    aggregates: RuntimeTurnAggregate[];
    scannedLogFiles: number;
} {
    if (!existsSync(logDir)) {
        return { aggregates: [], scannedLogFiles: 0 };
    }

    const files = readdirSync(logDir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort();
    const byTurnId = new Map<string, RuntimeTurnAggregate>();

    for (const fileName of files) {
        const fullPath = join(logDir, fileName);
        const lines = readFileSync(fullPath, "utf-8")
            .split(/\r?\n/)
            .filter(Boolean);

        for (const line of lines) {
            let record: Record<string, unknown>;
            try {
                record = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }

            if (record.channel !== "runtime") continue;
            const scope = record.scope;
            if (scope !== "llm.usage" && scope !== "turn.complete") continue;

            const payload = record.payload;
            const turnId = getTurnIdFromPayload(payload);
            if (!turnId) continue;

            const tsValue = typeof record.ts === "string" ? Date.parse(record.ts) / 1000 : NaN;
            const aggregate =
                byTurnId.get(turnId) ??
                {
                    turnId,
                    timestamp: Number.isFinite(tsValue) ? tsValue : 0,
                    answerHash: undefined,
                    answerPreview: undefined,
                    parentTurnId: undefined,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheHitTokens: 0,
                    cacheMissTokens: 0,
                    logFile: fileName,
                };

            if (!aggregate.timestamp && Number.isFinite(tsValue)) {
                aggregate.timestamp = tsValue;
            }

            if (scope === "llm.usage" && payload && typeof payload === "object") {
                const usagePayload = payload as Record<string, unknown>;
                const normalizedUsage = usagePayload.normalizedUsage as
                    | Record<string, unknown>
                    | undefined;
                if (normalizedUsage) {
                    aggregate.inputTokens += Number(normalizedUsage.promptTokens || 0);
                    aggregate.outputTokens += Number(normalizedUsage.completionTokens || 0);
                    aggregate.cacheHitTokens += Number(normalizedUsage.cacheHitTokens || 0);
                    aggregate.cacheMissTokens += Number(normalizedUsage.cacheMissTokens || 0);
                }
            }

            if (scope === "turn.complete" && payload && typeof payload === "object") {
                const completePayload = payload as Record<string, unknown>;
                aggregate.answerHash = getAnswerHashFromPayload(completePayload);
                aggregate.answerPreview = getAnswerPreviewFromPayload(completePayload);
                aggregate.totalLlmCalls = Number(completePayload.totalLlmCalls || 0);
                aggregate.parentTurnId = getStringPreview(completePayload.parentTurnId);
            }

            byTurnId.set(turnId, aggregate);
        }
    }

    return {
        aggregates: [...byTurnId.values()],
        scannedLogFiles: files.length,
    };
}

function readCandidateHistoryTurns(db: DatabaseSync): HistoryTurnRow[] {
    return db
        .prepare(
            [
                "SELECT",
                "id, timestamp, date, time_24h, ask, answer,",
                "turn_input_tokens, turn_output_tokens, cache_hit_tokens, cache_miss_tokens",
                "FROM turns",
                "WHERE answer != ''",
                "ORDER BY timestamp ASC, id ASC",
            ].join(" "),
        )
        .all() as unknown as HistoryTurnRow[];
}

function computeHistoryAnswerHash(turn: HistoryTurnRow): string {
    return hashDebugValue(turn.answer);
}

function chooseBestHistoryTurn(
    candidates: HistoryTurnRow[],
    runtimeTurn: RuntimeTurnAggregate,
    usedIds: Set<number>,
    maxTimeDeltaSeconds: number,
): HistoryTurnRow | null {
    const answerHash = runtimeTurn.answerHash;
    if (!answerHash) return null;

    const matches = candidates
        .filter((turn) => !usedIds.has(turn.id))
        .filter((turn) => computeHistoryAnswerHash(turn) === answerHash)
        .map((turn) => ({
            turn,
            delta: Math.abs(Number(turn.timestamp || 0) - Number(runtimeTurn.timestamp || 0)),
        }))
        .filter((item) => item.delta <= maxTimeDeltaSeconds)
        .sort((a, b) => a.delta - b.delta || a.turn.id - b.turn.id);

    return matches[0]?.turn ?? null;
}

function writeAuditReport(projectRoot: string, report: TokenUsageRepairReport): string {
    const dir = join(projectRoot, ".fyuobot", "history");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const auditPath = join(dir, `token-usage-repair-${stamp}.json`);
    writeFileSync(auditPath, JSON.stringify(report, null, 2), "utf-8");
    return auditPath;
}

export function repairHistoricalTokenUsage(
    options: RepairOptions = {},
): TokenUsageRepairReport {
    const projectRoot = options.projectRoot ?? resolveProjectRoot();
    const dbPath = join(projectRoot, ".fyuobot", "history", "history.db");
    const logDir = join(projectRoot, ".fyuobot", "log");
    const apply = options.apply === true;
    const maxTimeDeltaSeconds = Math.max(
        1,
        Math.round(options.maxTimeDeltaSeconds ?? 180),
    );

    const { aggregates, scannedLogFiles } = readRuntimeTurnAggregates(logDir);
    const db = new DatabaseSync(dbPath);

    try {
        const historyTurns = readCandidateHistoryTurns(db);
        const usedHistoryIds = new Set<number>();
        const repairedTurns: RepairMatch[] = [];
        const unmatchedRuntimeTurns: UnmatchedRuntimeTurn[] = [];

        for (const runtimeTurn of aggregates) {
            const llmCalls = Math.max(0, Math.round(runtimeTurn.totalLlmCalls ?? 0));
            if (!runtimeTurn.answerHash) {
                unmatchedRuntimeTurns.push({
                    runtimeTurnId: runtimeTurn.turnId,
                    timestamp: runtimeTurn.timestamp,
                    reason: "missing_answer_hash",
                    answerHash: undefined,
                    answerPreview: runtimeTurn.answerPreview,
                    logFile: runtimeTurn.logFile,
                    totalLlmCalls: llmCalls,
                });
                continue;
            }
            if (
                runtimeTurn.inputTokens <= 0 &&
                runtimeTurn.outputTokens <= 0 &&
                runtimeTurn.cacheHitTokens <= 0 &&
                runtimeTurn.cacheMissTokens <= 0
            ) {
                unmatchedRuntimeTurns.push({
                    runtimeTurnId: runtimeTurn.turnId,
                    timestamp: runtimeTurn.timestamp,
                    reason: "missing_usage",
                    answerHash: runtimeTurn.answerHash,
                    answerPreview: runtimeTurn.answerPreview,
                    logFile: runtimeTurn.logFile,
                    totalLlmCalls: llmCalls,
                });
                continue;
            }

            const matchedTurn = chooseBestHistoryTurn(
                historyTurns,
                runtimeTurn,
                usedHistoryIds,
                maxTimeDeltaSeconds,
            );
            if (!matchedTurn) {
                unmatchedRuntimeTurns.push({
                    runtimeTurnId: runtimeTurn.turnId,
                    timestamp: runtimeTurn.timestamp,
                    reason: "no_history_match",
                    answerHash: runtimeTurn.answerHash,
                    answerPreview: runtimeTurn.answerPreview,
                    logFile: runtimeTurn.logFile,
                    totalLlmCalls: llmCalls,
                });
                continue;
            }

            usedHistoryIds.add(matchedTurn.id);
            const before = normalizeTokenNumbers({
                inputTokens: matchedTurn.turn_input_tokens,
                outputTokens: matchedTurn.turn_output_tokens,
                cacheHitTokens: matchedTurn.cache_hit_tokens,
                cacheMissTokens: matchedTurn.cache_miss_tokens,
            });
            const after = normalizeTokenNumbers({
                inputTokens: runtimeTurn.inputTokens,
                outputTokens: runtimeTurn.outputTokens,
                cacheHitTokens: runtimeTurn.cacheHitTokens,
                cacheMissTokens: runtimeTurn.cacheMissTokens,
            });

            repairedTurns.push({
                turnRowId: matchedTurn.id,
                runtimeTurnId: runtimeTurn.turnId,
                before,
                after,
                timestampDeltaSeconds: Math.abs(
                    Number(matchedTurn.timestamp || 0) -
                        Number(runtimeTurn.timestamp || 0),
                ),
                date: matchedTurn.date,
                time24h: matchedTurn.time_24h,
                logFile: runtimeTurn.logFile,
                totalLlmCalls: llmCalls,
                answerHash: runtimeTurn.answerHash,
                answerPreview: runtimeTurn.answerPreview ?? matchedTurn.answer.slice(0, 120),
            });
        }

        const unmatchedHistoryTurns: UnmatchedHistoryTurn[] = historyTurns
            .filter((turn) => !usedHistoryIds.has(turn.id))
            .map((turn) => ({
                turnRowId: turn.id,
                date: turn.date,
                time24h: turn.time_24h,
                reason: "no_runtime_match",
                answerHash: computeHistoryAnswerHash(turn),
                answerPreview: turn.answer.slice(0, 160),
            }));

        const updatedTurns = repairedTurns.filter(
            (item) => !sameTokens(item.before, item.after),
        );
        const skippedAlreadyCorrectCount = repairedTurns.length - updatedTurns.length;

        if (apply && updatedTurns.length > 0) {
            const updateTurn = db.prepare(
                [
                    "UPDATE turns",
                    "SET turn_input_tokens = ?, turn_output_tokens = ?, cache_hit_tokens = ?, cache_miss_tokens = ?",
                    "WHERE id = ?",
                ].join(" "),
            );
            const updateActivity = db.prepare(
                [
                    "UPDATE daily_activities",
                    "SET turn_input_tokens = ?, turn_output_tokens = ?, cache_hit_tokens = ?, cache_miss_tokens = ?",
                    "WHERE turn_id = ?",
                ].join(" "),
            );

            db.exec("BEGIN");
            try {
                for (const item of updatedTurns) {
                    updateTurn.run(
                        item.after.inputTokens,
                        item.after.outputTokens,
                        item.after.cacheHitTokens,
                        item.after.cacheMissTokens,
                        item.turnRowId,
                    );
                    updateActivity.run(
                        item.after.inputTokens,
                        item.after.outputTokens,
                        item.after.cacheHitTokens,
                        item.after.cacheMissTokens,
                        item.turnRowId,
                    );
                }
                db.exec("COMMIT");
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        }

        if (apply) {
            const history = HistoryManager.instance(projectRoot);
            for (const item of unmatchedRuntimeTurns) {
                const runtime = aggregates.find((entry) => entry.turnId === item.runtimeTurnId);
                if (!runtime) continue;
                history.saveTokenUsageCorrection({
                    runtimeTurnId: runtime.turnId,
                    agentId: runtime.turnId,
                    agentKind: runtime.turnId.startsWith("sub_") ? "sub" : "main",
                    parentTurnId: runtime.parentTurnId ?? "",
                    source: "runtime_log_unmatched",
                    logFile: runtime.logFile,
                    timestamp: runtime.timestamp,
                    answerHash: runtime.answerHash ?? "",
                    answerPreview: runtime.answerPreview ?? "",
                    totalLlmCalls: runtime.totalLlmCalls ?? 0,
                    inputTokens: runtime.inputTokens,
                    outputTokens: runtime.outputTokens,
                    cacheHitTokens: runtime.cacheHitTokens,
                    cacheMissTokens: runtime.cacheMissTokens,
                });
            }
        }

        const report: TokenUsageRepairReport = {
            projectRoot,
            databasePath: dbPath,
            logDir,
            apply,
            maxTimeDeltaSeconds,
            scannedLogFiles,
            runtimeTurnCount: aggregates.length,
            candidateHistoryTurnCount: historyTurns.length,
            matchedTurnCount: repairedTurns.length,
            updatedTurnCount: updatedTurns.length,
            skippedAlreadyCorrectCount,
            unmatchedHistoryTurns,
            unmatchedRuntimeTurns,
            repairedTurns,
            auditPath: "",
        };
        report.auditPath = writeAuditReport(projectRoot, report);
        return report;
    } finally {
        db.close();
    }
}
