// src/tools/compress-tool.ts
// 上下文压缩工具 —— 压缩记忆文件以控制 token 消耗
//
// 支持主动调用（agent 自主压缩）和被动触发（系统在上下文过大时自动压缩）。
// 压缩策略：
//   auto      — 自动选择最佳策略（默认）
//   truncate  — 保留最近内容，删除旧内容
//   summarize — 保留标题结构 + 最近内容，旧的详细内容替换为摘要

import * as fs from "fs/promises";
import * as path from "path";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

// ── 常量 ────────────────────────────────────────────────────

const MEMORY_FILES: Record<string, string> = {
    history: "HISTORY.md",
    memory: "MEMORY.md",
    user: "USER.md",
    all: "", // 特殊值，压缩全部
};

const MEMORIES_DIR = path.resolve(process.cwd(), ".fyuobot", "memories");

/** 单文件大小阈值：超过此值（字节）建议压缩 */
const SIZE_THRESHOLD = 50 * 1024; // 50 KB

/** 截断模式下保留的最大字符数 */
const TRUNCATE_KEEP = 12_000;

// ── 压缩逻辑 ────────────────────────────────────────────────

interface CompressReport {
    file: string;
    originalSize: number;
    compressedSize: number;
    strategy: string;
}

/**
 * 压缩单个文件。
 *
 * 策略说明：
 * - auto: 根据文件大小自动选择（<阈值跳过，否则 summarize）
 * - truncate: 保留文件末尾最多 TRUNCATE_KEEP 字符
 * - summarize: 保留 markdown 标题结构和最近 3 个一级段落的详细内容，
 *              旧段落只保留标题 + 一行摘要
 */
function compressContent(content: string, strategy: string): { result: string; strategy: string } {
    // 空内容不压缩
    if (!content.trim()) {
        return { result: content, strategy: "skip (empty)" };
    }

    const size = Buffer.byteLength(content, "utf-8");

    // auto 模式下，小文件跳过
    if (strategy === "auto" && size < SIZE_THRESHOLD) {
        return { result: content, strategy: "skip (under threshold)" };
    }

    // auto 降级为 summarize
    const effectiveStrategy = strategy === "auto" ? "summarize" : strategy;

    switch (effectiveStrategy) {
        case "truncate":
            return { result: truncateContent(content), strategy: "truncate" };
        case "summarize":
            return { result: summarizeContent(content), strategy: "summarize" };
        default:
            return { result: content, strategy: "skip (unknown strategy)" };
    }
}

/** 截断：保留末尾最多 TRUNCATE_KEEP 字符 */
function truncateContent(content: string): string {
    if (content.length <= TRUNCATE_KEEP) return content;

    const header = "> ⚠ 旧内容已被截断压缩。\n\n";
    const kept = content.slice(-TRUNCATE_KEEP);
    // 从最近的换行处开始，避免截断行
    const firstNewline = kept.indexOf("\n");
    const cleanKept = firstNewline > 0 ? kept.slice(firstNewline + 1) : kept;

    return header + cleanKept;
}

/**
 * 摘要压缩：
 * - 按一级标题（# ...）分割段落
 * - 保留最后 3 个段落的完整内容
 * - 旧段落只保留标题 + 一行摘要指示
 */
function summarizeContent(content: string): string {
    // 按一级标题分割
    const sections = splitByH1(content);

    if (sections.length <= 3) {
        // 段落不多，尝试按二级标题压缩
        return summarizeByH2(content);
    }

    const keepCount = 3;
    const oldSections = sections.slice(0, -keepCount);
    const recentSections = sections.slice(-keepCount);

    const parts: string[] = [];

    // 汇总旧段落
    parts.push("> 📦 以下为压缩后的历史摘要（详细内容已移除，保留标题便于检索）\n");
    for (const sec of oldSections) {
        const title = extractTitle(sec);
        const brief = extractBrief(sec);
        parts.push(`### ${title}\n> ${brief}\n`);
    }

    // 保留最近段落
    parts.push("---\n");
    parts.push("> 📋 以下为最近记录（完整保留）\n");
    parts.push(...recentSections);

    return parts.join("\n");
}

/** 按二级标题压缩（用于只有一个一级标题的长文件） */
function summarizeByH2(content: string): string {
    const sections = splitByH2(content);
    if (sections.length <= 5) return content;

    const keepCount = 5;
    const oldSections = sections.slice(0, -keepCount);
    const recentSections = sections.slice(-keepCount);

    const parts: string[] = [];
    parts.push("> 📦 以下为压缩后的摘要\n");
    for (const sec of oldSections) {
        const title = extractTitle(sec);
        parts.push(`- **${title}**: *(已压缩)*`);
    }
    parts.push("\n---\n");
    parts.push("> 📋 以下为最近记录\n");
    parts.push(...recentSections);

    return parts.join("\n");
}

// ── Markdown 解析辅助 ────────────────────────────────────────

function splitByH1(content: string): string[] {
    const lines = content.split("\n");
    const sections: string[] = [];
    let current = "";

    for (const line of lines) {
        if (/^#\s/.test(line) && current.trim()) {
            sections.push(current.trimEnd());
            current = line + "\n";
        } else {
            current += line + "\n";
        }
    }
    if (current.trim()) sections.push(current.trimEnd());
    return sections;
}

function splitByH2(content: string): string[] {
    const lines = content.split("\n");
    const sections: string[] = [];
    let current = "";

    for (const line of lines) {
        if (/^##\s/.test(line) && current.trim()) {
            sections.push(current.trimEnd());
            current = line + "\n";
        } else {
            current += line + "\n";
        }
    }
    if (current.trim()) sections.push(current.trimEnd());
    return sections;
}

function extractTitle(section: string): string {
    const match = section.match(/^#+\s*(.+)/m);
    return match?.[1]?.trim() ?? "(无标题)";
}

function extractBrief(section: string): string {
    // 取标题后的前 80 个非空字符作为摘要
    const lines = section.split("\n");
    let afterTitle = false;
    const contentLines: string[] = [];
    for (const line of lines) {
        if (!afterTitle && /^#+\s/.test(line)) {
            afterTitle = true;
            continue;
        }
        if (afterTitle && line.trim() && !line.startsWith(">")) {
            contentLines.push(line.trim());
        }
    }
    const brief = contentLines.join(" ").slice(0, 120);
    return brief || "(无详细内容)";
}

// ── 工具类 ──────────────────────────────────────────────────

export class CompressTool extends BaseTool {
    name = "compress";
    description = [
        "压缩记忆文件以控制 token 消耗。",
        "",
        "HISTORY.md：压缩时会进行 分类→汇总→精炼→存入 SQLite 归档（.fyuobot/history/conversations.db）",
        "MEMORY.md / USER.md：保留标题和列表结构，压缩冗长段落",
        "",
        "策略（仅对 MEMORY/USER 有效，HISTORY 固定走归档管道）：",
        "- auto: 自动选择（默认）",
        "- truncate: 截断旧内容，仅保留最近部分",
        "- summarize: 保留标题结构和最近段落，旧内容压缩为摘要",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "file",
            type: "string",
            description: "要压缩的记忆文件：'history'、'memory'、'user' 或 'all'（压缩全部）",
            required: true,
            enum: ["history", "memory", "user", "all"],
        },
        {
            name: "strategy",
            type: "string",
            description: "压缩策略：'auto'（默认，自动选择）、'truncate'（截断）、'summarize'（摘要压缩）",
            required: false,
            enum: ["auto", "truncate", "summarize"],
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const file = args["file"] as string;
        const strategy = (args["strategy"] as string) || "auto";

        if (file === "all") {
            return this.#compressAll(strategy);
        }

        const fileName = MEMORY_FILES[file];
        if (!fileName) {
            return `❌ 未知的记忆文件: "${file}"，可选值: history, memory, user, all`;
        }

        return this.#compressOne(fileName, strategy);
    }

    async #compressOne(fileName: string, strategy: string): Promise<string> {
        // HISTORY.md → SQLite 归档管道
        if (fileName === "HISTORY.md") {
            return this.#compressHistory();
        }

        const filePath = path.join(MEMORIES_DIR, fileName);

        let content: string;
        try {
            content = await fs.readFile(filePath, "utf-8");
        } catch {
            return `❌ 无法读取 ${fileName}，文件可能不存在。`;
        }

        const originalSize = Buffer.byteLength(content, "utf-8");
        const { result, strategy: used } = compressContent(content, strategy);

        if (result === content) {
            return `ℹ️ ${fileName} 无需压缩（${(originalSize / 1024).toFixed(1)} KB，策略: ${used}）。`;
        }

        await fs.mkdir(MEMORIES_DIR, { recursive: true });
        await fs.writeFile(filePath, result, "utf-8");

        const compressedSize = Buffer.byteLength(result, "utf-8");
        const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(0);

        return [
            `✅ 已压缩 ${fileName}:`,
            `   策略: ${used}`,
            `   压缩前: ${(originalSize / 1024).toFixed(1)} KB`,
            `   压缩后: ${(compressedSize / 1024).toFixed(1)} KB`,
            `   缩减: ${reduction}%`,
        ].join("\n");
    }

    /** HISTORY.md → 触发 LLM 批量浓缩 */
    async #compressHistory(): Promise<string> {
        const { HistoryManager } = await import("../memory/history-manager.js");
        const hm = HistoryManager.instance();
        const bufBefore = hm.getBufferStats();
        const didCondense = hm.checkAndCondense();

        if (!didCondense) {
            return `ℹ️ HISTORY.md 缓冲区未达阈值（${bufBefore.charCount} / ${bufBefore.threshold} 字符），无需浓缩。`;
        }

        const bufAfter = hm.getBufferStats();
        const stats = hm.getStats();
        return [
            `✅ HISTORY.md 已触发 LLM 批量浓缩:`,
            `   浓缩前: ${(bufBefore.charCount / 1024).toFixed(1)} KB`,
            `   浓缩后: ${(bufAfter.charCount / 1024).toFixed(1)} KB`,
            `   数据库总记录: ${stats.conversationCount} 条 (${stats.dbSizeKB} KB)`,
        ].join("\n");
    }

    async #compressAll(strategy: string): Promise<string> {
        const files = ["HISTORY.md", "MEMORY.md", "USER.md"];
        const reports: string[] = [];

        for (const fileName of files) {
            const report = await this.#compressOne(fileName, strategy);
            reports.push(report);
        }

        return reports.join("\n\n");
    }

    // ── 静态方法：供系统被动触发 ──────────────────────────

    /**
     * 检查 HISTORY.md 缓冲区是否超过阈值。
     * 供 Agent 循环在每轮对话后调用。
     */
    static async checkAll(): Promise<
        Array<{ file: string; charCount: number; threshold: number; needsAction: boolean }>
    > {
        const { HistoryManager } = await import("../memory/history-manager.js");
        const hm = HistoryManager.instance();
        const buf = hm.getBufferStats();
        return [
            {
                file: "HISTORY.md",
                charCount: buf.charCount,
                threshold: buf.threshold,
                needsAction: buf.charCount > buf.threshold,
            },
        ];
    }

    /**
     * 自动检测并触发浓缩（被动触发入口）。
     */
    static async autoCompress(): Promise<string[]> {
        const { HistoryManager } = await import("../memory/history-manager.js");
        const hm = HistoryManager.instance();
        const logs: string[] = [];
        const buf = hm.getBufferStats();
        if (buf.charCount > buf.threshold) {
            const before = buf.charCount;
            hm.checkAndCondense();
            const after = hm.getBufferStats().charCount;
            logs.push(
                `📦 HISTORY.md LLM 批量浓缩 (${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB)`,
            );
        }
        return logs;
    }
}
