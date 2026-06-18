import type { NormalizedUsage } from "../middleware/types.js";

export interface TurnTokenTotals {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
}

export function accumulateUsageIntoTurn(
    totals: TurnTokenTotals,
    usage: NormalizedUsage,
    estimatedOutputTokensForCall: number,
): TurnTokenTotals {
    const promptTokens = Math.max(0, Math.round(usage.promptTokens || 0));
    const completionTokens = Math.max(
        0,
        Math.round(usage.completionTokens || 0),
    );
    const cacheHitTokens = Math.max(0, Math.round(usage.cacheHitTokens || 0));
    const cacheMissTokens = Math.max(
        0,
        Math.round(usage.cacheMissTokens || 0),
    );
    const estimatedOutputTokens = Math.max(
        0,
        Math.round(estimatedOutputTokensForCall || 0),
    );

    return {
        inputTokens: totals.inputTokens + promptTokens,
        // Keep the live estimate when the provider does not return completion usage.
        outputTokens:
            completionTokens > 0
                ? Math.max(
                      0,
                      totals.outputTokens -
                          estimatedOutputTokens +
                          completionTokens,
                  )
                : totals.outputTokens,
        cacheHitTokens: totals.cacheHitTokens + cacheHitTokens,
        cacheMissTokens: totals.cacheMissTokens + cacheMissTokens,
    };
}
