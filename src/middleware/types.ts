// src/middleware/types.ts
//
// 中间层核心类型定义。
// 统一的、与厂商无关的 usage 数据结构，以及 normalizer 接口。

/** 已知的厂商标识符 */
export type ProviderName = 'deepseek' | 'openai' | 'anthropic' | 'unknown';

/** 统一的、与厂商无关的 usage 汇总 */
export interface NormalizedUsage {
    /** 输入 / prompt token 数 */
    promptTokens: number;
    /** 输出 / completion token 数 */
    completionTokens: number;
    /** 总 token 数 */
    totalTokens: number;
    /** 从厂商缓存中命中的 prompt token 数（节省成本） */
    cacheHitTokens: number;
    /** 未命中缓存的 prompt token 数（需重新计算） */
    cacheMissTokens: number;
    /** 新写入缓存的 token 数（目前仅 Anthropic 提供） */
    cacheWriteTokens: number;
}

/** 全零 usage 哨兵值 */
export const EMPTY_USAGE: NormalizedUsage = Object.freeze({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
});

/**
 * UsageNormalizer — 解析单个厂商的原始 usage 对象，
 * 返回 NormalizedUsage 的部分字段（未提供的字段由调用方用默认值填充）。
 */
export interface UsageNormalizer {
    /** 厂商名称 */
    readonly provider: ProviderName;
    /** 解析原始 usage 对象，返回可识别的字段 */
    normalize(raw: Record<string, unknown>): Partial<NormalizedUsage>;
}
