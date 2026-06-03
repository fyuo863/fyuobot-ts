// src/middleware/providers/anthropic.ts
//
// Anthropic API usage normalizer。
// Anthropic 使用不同的字段命名：
//   - input_tokens / output_tokens（而非 prompt_tokens / completion_tokens）
//   - cache_read_input_tokens（命中缓存的输入 token）
//   - cache_creation_input_tokens（新写入缓存的输入 token）

import type { UsageNormalizer, NormalizedUsage, ProviderName } from '../types.js';

function num(v: unknown): number {
    return typeof v === 'number' ? v : 0;
}

export const anthropicNormalizer: UsageNormalizer = {
    provider: 'anthropic' as ProviderName,

    normalize(raw: Record<string, unknown>): Partial<NormalizedUsage> {
        const promptTokens = num(raw.input_tokens);
        const completionTokens = num(raw.output_tokens);
        const totalTokens = promptTokens + completionTokens;

        const cacheHitTokens = num(raw.cache_read_input_tokens);
        const cacheWriteTokens = num(raw.cache_creation_input_tokens);

        // 未命中 = 总输入 - 命中 - 写入
        const cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens - cacheWriteTokens);

        return {
            promptTokens,
            completionTokens,
            totalTokens,
            cacheHitTokens,
            cacheMissTokens,
            cacheWriteTokens,
        };
    },
};
