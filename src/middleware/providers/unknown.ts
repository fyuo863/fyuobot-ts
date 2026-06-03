// src/middleware/providers/unknown.ts
//
// 兜底 normalizer —— 只提取标准 OpenAI 兼容三字段，
// 所有缓存字段返回 0。

import type { UsageNormalizer, NormalizedUsage, ProviderName } from '../types.js';

function num(v: unknown): number {
    return typeof v === 'number' ? v : 0;
}

export const unknownNormalizer: UsageNormalizer = {
    provider: 'unknown' as ProviderName,

    normalize(raw: Record<string, unknown>): Partial<NormalizedUsage> {
        return {
            promptTokens: num(raw.prompt_tokens),
            completionTokens: num(raw.completion_tokens),
            totalTokens: num(raw.total_tokens),
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            cacheWriteTokens: 0,
        };
    },
};
