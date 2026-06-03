// src/middleware/provider.ts
//
// 通过 baseURL 自动检测 LLM 厂商。

import type { ProviderName } from './types.js';

/**
 * 根据 API base URL 检测厂商。
 * 简单子串匹配 —— 无需网络请求或额外配置。
 */
export function detectProvider(baseURL?: string): ProviderName {
    if (!baseURL) return 'unknown';

    const u = baseURL.toLowerCase();

    if (u.includes('deepseek')) return 'deepseek';
    if (u.includes('openai') || u.includes('api.openai')) return 'openai';
    if (u.includes('anthropic')) return 'anthropic';

    return 'unknown';
}
