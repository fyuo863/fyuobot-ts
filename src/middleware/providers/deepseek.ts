// src/middleware/providers/deepseek.ts
//
// DeepSeek API usage normalizer。
// DeepSeek 在标准 OpenAI usage 字段基础上增加了：
//   - prompt_cache_hit_tokens
//   - prompt_cache_miss_tokens

import type { UsageNormalizer, NormalizedUsage, ProviderName } from '../types.js';

function num(v: unknown): number {
    return typeof v === 'number' ? v : 0;
}

export const deepseekNormalizer: UsageNormalizer = {
    provider: 'deepseek' as ProviderName,

    normalize(raw: Record<string, unknown>): Partial<NormalizedUsage> {
        return {
            promptTokens: num(raw.prompt_tokens),
            completionTokens: num(raw.completion_tokens),
            totalTokens: num(raw.total_tokens),
            cacheHitTokens: num(raw.prompt_cache_hit_tokens),
            cacheMissTokens: num(raw.prompt_cache_miss_tokens),
            // DeepSeek 不暴露 cacheWriteTokens
            cacheWriteTokens: 0,
        };
    },
};
