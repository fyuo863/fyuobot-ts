// src/llm/tokens.ts
//
// 轻量 token 估算工具
// 采用字符级启发式算法，无需加载大型 tokenizer 词典，
// 对中英文混排文本提供近似 token 计数。

// CJK 统一表意文字区间（含中文、日文汉字、韩文汉字）
const CJK_RANGES: [number, number][] = [
    [0x4e00, 0x9fff], // CJK Unified Ideographs
    [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
    [0x20000, 0x2a6df], // CJK Unified Ideographs Extension B
    [0x2a700, 0x2b73f], // Extension C
    [0x2b740, 0x2b81f], // Extension D
    [0x2b820, 0x2ceaf], // Extension E
    [0x2ceb0, 0x2ebef], // Extension F
    [0xf900, 0xfaff], // CJK Compatibility Ideographs
    [0x2f800, 0x2fa1f], // CJK Compatibility Supplement
];

// CJK 标点、全角符号
const CJK_PUNCT_RANGES: [number, number][] = [
    [0x3000, 0x303f], // CJK Symbols and Punctuation
    [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
    [0x2000, 0x206f], // General Punctuation (em-space etc.)
    [0xfe30, 0xfe4f], // CJK Compatibility Forms
];

// 日语假名
const KANA_RANGES: [number, number][] = [
    [0x3040, 0x309f], // Hiragana
    [0x30a0, 0x30ff], // Katakana
    [0xff65, 0xff9f], // Halfwidth Katakana
];

// 韩文
const HANGUL_RANGES: [number, number][] = [
    [0xac00, 0xd7af], // Hangul Syllables
    [0x1100, 0x11ff], // Hangul Jamo
];

const ALL_MULTI_BYTE_TOKEN_RANGES: [number, number][] = [
    ...CJK_RANGES,
    ...CJK_PUNCT_RANGES,
    ...KANA_RANGES,
    ...HANGUL_RANGES,
];

function isMultiByteTokenChar(codePoint: number): boolean {
    return ALL_MULTI_BYTE_TOKEN_RANGES.some(
        ([lo, hi]) => codePoint >= lo && codePoint <= hi,
    );
}

/**
 * 估算文本的 token 数量。
 *
 * 启发式规则（基于常见 LLM tokenizer 的近似）：
 * - CJK/假名/韩文 字符 → ~1.5 tokens/char
 * - 其他字符（ASCII、拉丁扩展等）→ ~0.25 tokens/char（≈4 chars/token）
 *
 * 精度通常在 ±20% 以内，足以用于实时 UI 展示。
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;

    let cjkCount = 0;
    let otherCount = 0;

    for (let i = 0; i < text.length; i++) {
        const cp = text.codePointAt(i);
        if (cp === undefined) {
            otherCount++;
            continue;
        }

        // 处理代理对（高代理项时跳过低位）
        if (cp > 0xffff) i++;

        if (isMultiByteTokenChar(cp)) {
            cjkCount++;
        } else {
            otherCount++;
        }
    }

    return Math.max(1, Math.round(cjkCount * 1.5 + otherCount * 0.25));
}

/** Token 统计快照 */
export interface TokenStats {
    /** 当前轮次输入 token 数 */
    turnInputTokens: number;
    /** 当前轮次输出 token 数 */
    turnOutputTokens: number;
    /** 会话累计输入 token 数 */
    sessionInputTokens: number;
    /** 会话累计输出 token 数 */
    sessionOutputTokens: number;
    /** 当前轮次输出速率（tokens/s），轮次结束时为平均速率 */
    tokensPerSecond: number;
}

/** 格式化 token 数量为可读字符串（1.2k, 3.4M 等） */
export function formatTokenCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}
