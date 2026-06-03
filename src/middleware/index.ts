// src/middleware/index.ts
//
// 中间层入口 —— registry + normalizeUsage 入口函数。
// 导入此模块会自动注册所有内置 normalizer。

import type { ProviderName, NormalizedUsage, UsageNormalizer } from './types.js';
import { EMPTY_USAGE } from './types.js';
import { deepseekNormalizer } from './providers/deepseek.js';
import { openaiNormalizer } from './providers/openai.js';
import { anthropicNormalizer } from './providers/anthropic.js';
import { unknownNormalizer } from './providers/unknown.js';

// ── Registry ──────────────────────────────────────────────────

const registry = new Map<ProviderName, UsageNormalizer>();

/** 注册一个自定义 normalizer（用于扩展新厂商） */
export function registerNormalizer(normalizer: UsageNormalizer): void {
    registry.set(normalizer.provider, normalizer);
}

/** 初始化内置 normalizer —— 模块加载时自动执行 */
function initializeBuiltins(): void {
    registerNormalizer(deepseekNormalizer);
    registerNormalizer(openaiNormalizer);
    registerNormalizer(anthropicNormalizer);
    registerNormalizer(unknownNormalizer);
}

initializeBuiltins();

// ── 公开 API ──────────────────────────────────────────────────

/**
 * 将厂商原始 usage 对象标准化为 NormalizedUsage。
 *
 * @param provider  由 detectProvider() 得出的厂商标识
 * @param raw       API 返回的原始 usage 对象（来自 chunk.usage）
 * @returns         统一格式的 usage 汇总
 */
export function normalizeUsage(
    provider: ProviderName,
    raw: Record<string, unknown>,
): NormalizedUsage {
    const normalizer = registry.get(provider);
    if (!normalizer) {
        // 未知厂商：回退到 unknown normalizer
        const fallback = unknownNormalizer.normalize(raw);
        return { ...EMPTY_USAGE, ...fallback };
    }
    const partial = normalizer.normalize(raw);
    return { ...EMPTY_USAGE, ...partial };
}

// 重导出类型和工具函数
export type { NormalizedUsage, UsageNormalizer };
export { EMPTY_USAGE } from './types.js';
export { detectProvider } from './provider.js';
