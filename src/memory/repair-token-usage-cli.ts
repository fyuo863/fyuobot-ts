import { repairHistoricalTokenUsage } from "./token-usage-repair.js";

function printUsage(): void {
    console.log(
        [
            "Usage:",
            "  node --import tsx src/memory/repair-token-usage-cli.ts --dry-run",
            "  node --import tsx src/memory/repair-token-usage-cli.ts --apply",
            "",
            "Options:",
            "  --dry-run           Preview matches without writing to history.db",
            "  --apply             Update turns and daily_activities token columns",
            "  --max-delta=<secs>  Maximum allowed time gap for matching (default: 180)",
        ].join("\n"),
    );
}

function parseArgs(argv: string[]): { apply: boolean; maxTimeDeltaSeconds?: number } {
    let apply = false;
    let sawMode = false;
    let maxTimeDeltaSeconds: number | undefined;

    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        }
        if (arg === "--apply") {
            apply = true;
            sawMode = true;
            continue;
        }
        if (arg === "--dry-run") {
            apply = false;
            sawMode = true;
            continue;
        }
        if (arg.startsWith("--max-delta=")) {
            const raw = arg.slice("--max-delta=".length);
            const parsed = Number.parseInt(raw, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                maxTimeDeltaSeconds = parsed;
                continue;
            }
            throw new Error(`Invalid --max-delta value: ${raw}`);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    if (!sawMode) {
        apply = false;
    }

    return maxTimeDeltaSeconds === undefined
        ? { apply }
        : { apply, maxTimeDeltaSeconds };
}

function formatTurnPreview(preview: string | undefined): string {
    return JSON.stringify(String(preview || "").replace(/\s+/g, " ").slice(0, 80));
}

if (process.argv[1]?.endsWith("repair-token-usage-cli.ts")) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const report = repairHistoricalTokenUsage(options);

        console.log(
            [
                `mode=${report.apply ? "apply" : "dry-run"}`,
                `scannedLogFiles=${report.scannedLogFiles}`,
                `runtimeTurns=${report.runtimeTurnCount}`,
                `historyTurns=${report.candidateHistoryTurnCount}`,
                `matched=${report.matchedTurnCount}`,
                `updated=${report.updatedTurnCount}`,
                `alreadyCorrect=${report.skippedAlreadyCorrectCount}`,
                `unmatchedRuntime=${report.unmatchedRuntimeTurns.length}`,
                `unmatchedHistory=${report.unmatchedHistoryTurns.length}`,
                `audit=${report.auditPath}`,
            ].join("\n"),
        );

        for (const item of report.repairedTurns.slice(0, 20)) {
            const changed =
                item.before.inputTokens !== item.after.inputTokens ||
                item.before.outputTokens !== item.after.outputTokens ||
                item.before.cacheHitTokens !== item.after.cacheHitTokens ||
                item.before.cacheMissTokens !== item.after.cacheMissTokens;
            console.log(
                [
                    "",
                    `[${changed ? "update" : "skip"}] turn_row=${item.turnRowId} runtime_turn=${item.runtimeTurnId} llm_calls=${item.totalLlmCalls} delta=${item.timestampDeltaSeconds}s`,
                    `  before: in=${item.before.inputTokens} out=${item.before.outputTokens} hit=${item.before.cacheHitTokens} miss=${item.before.cacheMissTokens}`,
                    `  after : in=${item.after.inputTokens} out=${item.after.outputTokens} hit=${item.after.cacheHitTokens} miss=${item.after.cacheMissTokens}`,
                    `  answer: ${formatTurnPreview(item.answerPreview)}`,
                ].join("\n"),
            );
        }

        if (report.repairedTurns.length > 20) {
            console.log(`\n... ${report.repairedTurns.length - 20} more matched turns in audit file`);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        printUsage();
        process.exitCode = 1;
    }
}
