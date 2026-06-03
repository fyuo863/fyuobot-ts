// src/middleware/providers/openai.ts
//
// OpenAI API usage normalizer。
// OpenAI 将缓存命中 token 放在 prompt_tokens_details.cached_tokens 中。

import type { UsageNormalizer, NormalizedUsage, ProviderName } from '../types.js';

function num(v: unknown): number {
    return typeof v === 'number' ? v : 0;
}

export const openaiNormalizer: UsageNormalizer = {
    provider: 'openai' as ProviderName,

    normalize(raw: Record<string, unknown>): Partial<NormalizedUsage> {
        const promptTokens = num(raw.prompt_tokens);
        const completionTokens = num(raw.completion_tokens);
        const totalTokens = num(raw.total_tokens);

        const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
        const cacheHitTokens = num(details?.cached_tokens);

        // OpenAI 不直接提供 cacheMissTokens，从 promptTokens 推导
        const cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens);

        return {
            promptTokens,
            completionTokens,
            totalTokens,
            cacheHitTokens,
            cacheMissTokens,
            cacheWriteTokens: 0,
        };
    },
};
