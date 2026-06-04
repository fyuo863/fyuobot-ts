// src/tui/linkify.ts
//
// 文件路径 / URL → OSC 8 超链接转换。
// 将终端输出中的文件路径和 URL 包装为 OSC 8 转义序列，使终端支持
// Ctrl+Click 直接打开（Windows Terminal、VS Code 集成终端等均支持）。
//
// OSC 8 格式：
//   \x1b]8;;<URI>\x1b\\<显示文本>\x1b]8;;\x1b\\

import { resolve, isAbsolute } from "node:path";

// ════════════════════════════════════════════════════════════════
// OSC 8 转义序列构建
// ════════════════════════════════════════════════════════════════

const ESC = "\x1b";
const ST = `${ESC}\\`; // 字符串终止符 (ESC \)

/**
 * 将文本包装为 OSC 8 超链接。
 * 终端会渲染为可点击的链接文本，Ctrl+Click 打开。
 */
function osc8Link(uri: string, displayText: string): string {
    return `${ESC}]8;;${uri}${ST}${displayText}${ESC}]8;;${ST}`;
}

// ════════════════════════════════════════════════════════════════
// 路径解析
// ════════════════════════════════════════════════════════════════

/**
 * 将文件系统路径转为 file:// URI。
 *
 * Windows:  C:\Users\foo\bar.ts → file:///C:/Users/foo/bar.ts
 * Unix:     /home/foo/bar.ts    → file:///home/foo/bar.ts
 */
function toFileUri(filePath: string): string {
    // resolve 相对路径 → 绝对路径
    const absolute = isAbsolute(filePath)
        ? filePath
        : resolve(process.cwd(), filePath);

    // 统一使用正斜杠
    const normalized = absolute.replace(/\\/g, "/");

    // Windows 驱动器号: C:/... → /C:/...
    if (/^[A-Za-z]:/.test(normalized)) {
        return `file:///${normalized}`;
    }

    // Unix 路径: /home/... → file:///home/...
    return `file://${normalized}`;
}

// ════════════════════════════════════════════════════════════════
// 正则模式
// ════════════════════════════════════════════════════════════════

/**
 * 匹配以下文件路径形式：
 *
 *   1. Windows 绝对路径（含盘符）
 *      C:\Users\foo\bar.ts
 *      D:\Program Data\project\file.ts:42
 *
 *   2. Unix 绝对路径
 *      /home/user/project/src/file.ts
 *
 *   3. 当前目录相对路径（以 ./ 或 ../ 开头）
 *      ./src/tui/markdown.tsx
 *      ../../file.ts:42-51
 *
 *   4. 项目目录相对路径（字母/数字/下划线/点/连字符开头，至少含一个分隔符）
 *      src/tui/markdown.tsx
 *      .fyuobot/tools/api-server/index.ts
 *
 * 排除：
 *   - URL（http://, https://）—— 由 linkifyUrls() 单独处理
 *   - 纯文件名（无路径分隔符）
 *   - 除路径相关外的普通单词
 */
const FILE_PATH_RE =
    /(?:[A-Za-z]:[\\/][\w\s.\-~()]+(?:[\\/][\w\s.\-~()]+)*\.[\w]{1,10}(?::\d+(?:-\d+)?)?)|(?:\/(?:[\w.\-~()]+[\\/])+[\w.\-~()]*\.[\w]{1,10}(?::\d+(?:-\d+)?)?)|(?:(?:\.{1,2}[\\/])+(?:[\w.\-~()]+[\\/])*[\w.\-~()]*\.[\w]{1,10}(?::\d+(?:-\d+)?)?)|(?:[\w.\-~]+(?:[\\/][\w.\-~()]+)+\.[\w]{1,10}(?::\d+(?:-\d+)?)?)/g;

/** URL 模式 —— 用于在替换回调中排除 URL 内的路径 */
const URL_RE = /https?:\/\/\S+/g;

/**
 * 裸 URL 模式 —— 匹配未被 markdown 链接语法包裹的 http/https URL。
 * 排除：
 *   - 已含 OSC 8 序列的（不重复处理）
 *   - markdown 链接语法 [text](url) 中的 URL
 *   - 已由 marked 渲染为链接的（含有 ANSI 序列的）
 */
const BARE_URL_RE = /https?:\/\/[^\s()<>\[\]"'\x1b]+/g;

// ════════════════════════════════════════════════════════════════
// 公共 API
// ════════════════════════════════════════════════════════════════

/**
 * 将文本中所有可识别的文件路径转换为 OSC 8 超链接。
 *
 * 在终端中渲染后，用户可以 Ctrl+Click 直接打开文件。
 * 对已包含 OSC 8 序列或 URL 的内容不做重复处理。
 *
 * @param text  输入文本（可能包含文件路径）
 * @returns     将文件路径替换为 OSC 8 链接后的文本
 */
export function linkifyFilePaths(text: string): string {
    if (!text) return text;

    // 避免重复处理已含 OSC 8 序列的文本
    if (text.includes(`${ESC}]8;`)) return text;

    // 收集所有 URL 占据的字符范围，避免将 URL 路径误识别为文件路径
    const urlRanges: Array<[number, number]> = [];
    URL_RE.lastIndex = 0;
    for (let m = URL_RE.exec(text); m !== null; m = URL_RE.exec(text)) {
        urlRanges.push([m.index, m.index + m[0].length]);
    }

    // 重置 lastIndex（全局正则的状态）
    FILE_PATH_RE.lastIndex = 0;

    return text.replace(FILE_PATH_RE, (match, ...args) => {
        // 检查匹配位置是否在某个 URL 范围内
        const offset = (args[args.length - 2] as number);
        for (const [start, end] of urlRanges) {
            if (offset >= start && offset < end) {
                // 路径是 URL 的一部分，保持原样
                return match;
            }
        }

        try {
            const uri = toFileUri(match);
            return osc8Link(uri, match);
        } catch {
            // 路径解析失败时保留原文
            return match;
        }
    });
}

/**
 * 将文本中的裸 URL（http/https）转换为 OSC 8 超链接。
 *
 * 自动跳过已被 markdown 链接语法 `[text](url)` 包裹的 URL，
 * 以及已包含 OSC 8 / ANSI 转义序列的文本。
 *
 * Ctrl+Click 链接会在默认浏览器中打开。
 *
 * @param text  输入文本（可能包含裸 URL）
 * @returns     将裸 URL 替换为 OSC 8 链接后的文本
 */
export function linkifyUrls(text: string): string {
    if (!text) return text;

    // 避免重复处理已含 OSC 8 序列的文本
    if (text.includes(`${ESC}]8;`)) return text;

    BARE_URL_RE.lastIndex = 0;

    return text.replace(BARE_URL_RE, (match, ...args) => {
        const offset = (args[args.length - 2] as number);

        // 跳过 markdown 链接语法 [text](url) 中的 URL
        // 检查前方是否有 "](" 且该括号比最近的 "[" 更近
        const before = text.slice(0, offset);
        const lastOpenBracket = before.lastIndexOf("[");
        const lastParenOpen = before.lastIndexOf("](");

        if (lastParenOpen !== -1 && lastParenOpen > lastOpenBracket) {
            // URL 被 markdown [text](...) 包裹，保持原样（marked 会处理渲染）
            return match;
        }

        // 确保 URL 以 http:// 或 https:// 开头
        const uri = match.startsWith("http") ? match : `https://${match}`;

        return osc8Link(uri, match);
    });
}

/**
 * 将文本中的文件路径和裸 URL 同时转换为 OSC 8 超链接。
 *
 * 等价于依次调用 `linkifyFilePaths` 和 `linkifyUrls`，
 * 文件路径优先级高于 URL（先处理路径，再处理 URL）。
 *
 * 推荐在渲染 Agent 输出前调用此函数。
 */
export function linkifyAll(text: string): string {
    if (!text) return text;
    // 先处理文件路径，再处理 URL（两者正则互不干扰）
    return linkifyUrls(linkifyFilePaths(text));
}
