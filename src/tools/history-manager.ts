// src/tools/history-manager.ts
//
// 历史记录管理器 —— 自动检测 .md 文件字符数，超出阈值时触发压缩归档。
//
// 架构：
//   HISTORY.md  →  被动全量记录（每轮对话自动追加）
//                  ↓ 超阈值
//               压缩 → 分类 → 汇总 → 精炼
//                  ↓
//   conversations.db (SQLite)  ← 持久化归档
//
// MEMORY.md / USER.md  →  超阈值时触发轻量压缩（保留核心内容）

import { DatabaseSync } from "node:sqlite";
import * as fs from "fs/promises";
import { mkdirSync, statSync } from "fs";
import * as path from "path";

// ── 路径常量 ──────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const MEMORIES_DIR = path.join(PROJECT_ROOT, ".fyuobot", "memories");
const HISTORY_DIR = path.join(PROJECT_ROOT, ".fyuobot", "history");
const DB_PATH = path.join(HISTORY_DIR, "conversations.db");

// ── 阈值配置（字符数）─────────────────────────────────────────

export const CHAR_THRESHOLDS: Record<string, number> = {
    "HISTORY.md": 20_000, // 超过 2 万字符 → 触发 SQLite 归档
    "MEMORY.md": 10_000,  // 超过 1 万字符 → 触发轻量压缩
    "USER.md": 10_000,    // 超过 1 万字符 → 触发轻量压缩
};

// ── SQLite Schema ─────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT,
    key_points TEXT,
    tools_used TEXT,
    raw_chars INTEGER DEFAULT 0,
    compressed_chars INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS memory_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    content_snapshot TEXT NOT NULL,
    char_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_date ON conversations(date);
CREATE INDEX IF NOT EXISTS idx_conversations_category ON conversations(category);
CREATE INDEX IF NOT EXISTS idx_snapshots_file ON memory_snapshots(file_name);
`;

// ── 类型 ──────────────────────────────────────────────────────

export interface ConversationRecord {
    date: string;
    summary: string;
    category: string;
    keyPoints: string[];
    toolsUsed: string[];
    rawChars: number;
    compressedChars: number;
}

export interface ThresholdCheck {
    file: string;
    path: string;
    charCount: number;
    threshold: number;
    needsAction: boolean;
}

export interface ArchiveResult {
    file: string;
    recordsStored: number;
    originalChars: number;
    compressedChars: number;
    snapshotId: number;
}

// ── 数据库单例 ────────────────────────────────────────────────

let _db: DatabaseSync | null = null;

function getDB(): DatabaseSync {
    if (!_db) {
        mkdirSync(HISTORY_DIR, { recursive: true });
        _db = new DatabaseSync(DB_PATH);
        _db.exec(SCHEMA_SQL);
    }
    return _db;
}

function closeDB(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

// ── 检测机制：自动检测文件字符数 ──────────────────────────────

/**
 * 扫描 .fyuobot/memories/ 下所有 .md 文件，
 * 返回超过阈值的文件列表。
 */
export async function checkThresholds(): Promise<ThresholdCheck[]> {
    const results: ThresholdCheck[] = [];
    const files = Object.keys(CHAR_THRESHOLDS);

    for (const fileName of files) {
        const filePath = path.join(MEMORIES_DIR, fileName);
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const charCount = content.length;
            const threshold = CHAR_THRESHOLDS[fileName] ?? 50_000;

            results.push({
                file: fileName,
                path: filePath,
                charCount,
                threshold,
                needsAction: charCount > threshold,
            });
        } catch {
            // 文件不存在，跳过
        }
    }

    return results;
}

/**
 * 获取单个文件的字符统计。
 */
export async function getFileStats(fileName: string): Promise<{
    exists: boolean;
    charCount: number;
    threshold: number;
    percentUsed: number;
}> {
    const filePath = path.join(MEMORIES_DIR, fileName);
    try {
        const content = await fs.readFile(filePath, "utf-8");
        const charCount = content.length;
        const threshold = CHAR_THRESHOLDS[fileName] ?? 50_000;
        return {
            exists: true,
            charCount,
            threshold,
            percentUsed: Math.round((charCount / threshold) * 100),
        };
    } catch {
        return { exists: false, charCount: 0, threshold: CHAR_THRESHOLDS[fileName] ?? 0, percentUsed: 0 };
    }
}

// ── 分类与精炼 ────────────────────────────────────────────────

/** 基于内容关键词检测分类 */
const CATEGORY_RULES: Array<{ keywords: RegExp; category: string }> = [
    { keywords: /偏好|喜欢|讨厌|习惯|食物|风格|语言/, category: "user_preference" },
    { keywords: /配置|config|设置|环境变量|env/i, category: "configuration" },
    { keywords: /代码|函数|编程|重构|实现|修复|bug|错误|fix/i, category: "coding" },
    { keywords: /工具|tool|execute_bash|file_operator|memory|compress/i, category: "tool_usage" },
    { keywords: /MCP|server|连接|协议/, category: "mcp_integration" },
    { keywords: /prompt|提示词|缓存|cache|token/i, category: "prompt_engineering" },
    { keywords: /UI|TUI|界面|显示|终端|Ink|React/i, category: "ui_development" },
];

function detectCategory(text: string): string {
    for (const rule of CATEGORY_RULES) {
        if (rule.keywords.test(text)) return rule.category;
    }
    return "general";
}

/** 提取工具名称 */
const TOOL_PATTERN = /\b(execute_bash|file_operator|memory|compress|mcp_\w+)\b/g;

function detectTools(text: string): string[] {
    const tools = new Set<string>();
    let match;
    while ((match = TOOL_PATTERN.exec(text)) !== null) {
        if (match[1]) tools.add(match[1]);
    }
    return [...tools].sort();
}

/** 提取关键点（列表项） */
function extractKeyPoints(text: string): string[] {
    const lines = text.split("\n");
    const points: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        // Markdown 列表项：- 或 * 或 数字.
        if (/^[-*]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
            const cleaned = trimmed.replace(/^[-*\d]+[.)]\s*/, "").trim();
            if (cleaned && cleaned.length < 200) {
                points.push(cleaned);
            }
        }
    }

    // 去重 + 限制数量
    return [...new Set(points)].slice(0, 10);
}

/** 生成摘要：取段落首句 + 裁剪 */
function generateSummary(text: string): string {
    // 移除 markdown 标题行
    const lines = text.split("\n").filter((l) => !/^#+\s/.test(l.trim()));
    const body = lines.join(" ").replace(/\s+/g, " ").trim();

    // 取前 300 字符，在词边界截断
    if (body.length <= 300) return body;
    const truncated = body.slice(0, 300);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 200 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

// ── HISTORY.md 解析：分节 → 精炼 ──────────────────────────────

/**
 * 将 HISTORY.md 内容按日期标题（## YYYY-MM-DD）拆分为对话段落。
 * 如果没有日期标题，则整体作为一个段落。
 */
function parseHistorySections(content: string): Array<{ date: string; body: string }> {
    const sections: Array<{ date: string; body: string }> = [];

    // 按 ## 标题分割
    const parts = content.split(/(?=^##\s)/m);

    let defaultDate = new Date().toISOString().slice(0, 10);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // 跳过纯标题行（没有实质内容）
        const headerMatch = trimmed.match(/^##\s+(.+)/m);
        if (headerMatch?.[1]) {
            const headerContent = headerMatch[1].trim();
            // 尝试解析日期
            const dateMatch = headerContent.match(/(\d{4}-\d{2}-\d{2})/);
            const date = dateMatch?.[1] ?? defaultDate;

            // 更新默认日期
            if (dateMatch?.[1]) defaultDate = date;

            // 去掉标题行得到正文
            const body = trimmed.replace(/^##\s+.+\n?/m, "").trim();
            if (body) {
                sections.push({ date, body });
            }
        } else if (trimmed) {
            // 没有标题的内容，使用默认日期
            sections.push({ date: defaultDate, body: trimmed });
        }
    }

    return sections;
}

/**
 * 精炼单个对话段落：分类 + 摘要 + 关键点 + 工具提取。
 */
function refineSection(date: string, body: string): ConversationRecord {
    const category = detectCategory(body);
    const summary = generateSummary(body);
    const keyPoints = extractKeyPoints(body);
    const toolsUsed = detectTools(body);

    return {
        date,
        summary,
        category,
        keyPoints,
        toolsUsed,
        rawChars: body.length,
        compressedChars: summary.length,
    };
}

// ── HISTORY.md → SQLite 归档管道 ─────────────────────────────

/**
 * 运行 HISTORY.md 归档管道：
 *   1. 读取 HISTORY.md
 *   2. 解析为对话段落
 *   3. 逐段精炼（分类 + 摘要 + 关键点）
 *   4. 批量存入 SQLite
 *   5. 创建完整快照
 *   6. 重置 HISTORY.md
 */
export async function processHistoryPipeline(): Promise<ArchiveResult> {
    const filePath = path.join(MEMORIES_DIR, "HISTORY.md");

    // 1. 读取
    let content: string;
    try {
        content = await fs.readFile(filePath, "utf-8");
    } catch {
        return {
            file: "HISTORY.md",
            recordsStored: 0,
            originalChars: 0,
            compressedChars: 0,
            snapshotId: 0,
        };
    }

    const originalChars = content.length;
    if (originalChars === 0) {
        return { file: "HISTORY.md", recordsStored: 0, originalChars: 0, compressedChars: 0, snapshotId: 0 };
    }

    // 2. 解析
    const sections = parseHistorySections(content);
    if (sections.length === 0) {
        return { file: "HISTORY.md", recordsStored: 0, originalChars, compressedChars: 0, snapshotId: 0 };
    }

    // 3. 精炼
    const records = sections.map((s) => refineSection(s.date, s.body));

    // 4. 存入 SQLite
    const db = getDB();
    const insertSQL = `
        INSERT INTO conversations (date, summary, category, key_points, tools_used, raw_chars, compressed_chars)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const insert = db.prepare(insertSQL);
    for (const r of records) {
        insert.run(
            r.date,
            r.summary,
            r.category,
            r.keyPoints.join("; "),
            r.toolsUsed.join(", "),
            r.rawChars,
            r.compressedChars,
        );
    }

    // 5. 创建快照
    const snapshotSQL = `
        INSERT INTO memory_snapshots (file_name, content_snapshot, char_count)
        VALUES (?, ?, ?)
    `;
    const snapshot = db.prepare(snapshotSQL);
    const snapshotResult = snapshot.run("HISTORY.md", content, originalChars);
    const snapshotId = Number(snapshotResult.lastInsertRowid ?? 0);

    const totalCompressed = records.reduce((sum, r) => sum + r.compressedChars, 0);

    // 6. 重置 HISTORY.md
    const header = [
        "# 对话历史",
        "",
        `> 此文件为对话缓冲区，被动全量记录每轮对话。`,
        `> 上次归档: ${new Date().toLocaleString("zh-CN")}`,
        `> 归档记录数: ${records.length} 条 | 原始 ${(originalChars / 1024).toFixed(1)}KB → 精炼 ${(totalCompressed / 1024).toFixed(1)}KB`,
        `> 已归档至: .fyuobot/history/conversations.db（快照 #${snapshotId ?? "?"}）`,
        `> 使用 memory 工具读取历史，或查询 SQLite 获取已归档记录。`,
        "",
        "## 最近对话",
        "",
        "（待记录…）",
        "",
    ].join("\n");

    await fs.mkdir(MEMORIES_DIR, { recursive: true });
    await fs.writeFile(filePath, header, "utf-8");

    return {
        file: "HISTORY.md",
        recordsStored: records.length,
        originalChars,
        compressedChars: totalCompressed,
        snapshotId,
    };
}

// ── 自动记录：每轮对话结束后被动追加到 HISTORY.md ──────────

/**
 * 每轮对话结束后自动追加记录到 HISTORY.md。
 * 由 agentLogic / agent 在对话回合完成时调用，无需 agent 手动操作。
 */
export async function appendTurnToHistory(entry: {
    query: string;
    response: string;
    tools: string[];
}): Promise<void> {
    const filePath = path.join(MEMORIES_DIR, "HISTORY.md");
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

    // 截断过长的响应（保留前 2000 字符 + 提示）
    let responseExcerpt = entry.response;
    if (responseExcerpt.length > 2000) {
        responseExcerpt =
            responseExcerpt.slice(0, 2000) +
            `\n\n> …（响应过长，已截断。完整长度: ${entry.response.length} 字符）`;
    }

    const toolSection =
        entry.tools.length > 0
            ? `\n- **工具**: ${entry.tools.map((t) => `\`${t}\``).join(", ")}`
            : "";

    const record = [
        `## ${dateStr} ${timeStr}`,
        "",
        `**用户**: ${entry.query.slice(0, 500)}`,
        "",
        `**Agent**: ${responseExcerpt}`,
        toolSection,
        "",
        "---",
        "",
    ].join("\n");

    await fs.mkdir(MEMORIES_DIR, { recursive: true });

    // 追加到文件
    let existing = "";
    try {
        existing = await fs.readFile(filePath, "utf-8");
    } catch {
        // 文件不存在，使用默认头部
        existing = [
            "# 对话历史",
            "",
            "> 此文件为对话缓冲区，被动全量记录每轮对话。",
            "> 当文件过大时，历史记录会自动归档到 `.fyuobot/history/conversations.db`。",
            "",
        ].join("\n");
    }

    const separator = existing.endsWith("\n") ? "" : "\n";
    await fs.writeFile(filePath, existing + separator + record, "utf-8");
}

// ── SQLite 查询接口 ───────────────────────────────────────────

/** 按分类统计对话记录数 */
export function getCategoryStats(): Array<{ category: string; count: number }> {
    const db = getDB();
    const stmt = db.prepare(
        "SELECT category, COUNT(*) as count FROM conversations GROUP BY category ORDER BY count DESC",
    );
    return stmt.all() as Array<{ category: string; count: number }>;
}

/** 按日期范围查询对话记录 */
export function queryConversations(opts: {
    category?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
}): ConversationRecord[] {
    const db = getDB();
    const conditions: string[] = [];
    const params: string[] = [];

    if (opts.category) {
        conditions.push("category = ?");
        params.push(opts.category);
    }
    if (opts.dateFrom) {
        conditions.push("date >= ?");
        params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
        conditions.push("date <= ?");
        params.push(opts.dateTo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;

    const stmt = db.prepare(
        `SELECT date, summary, category, key_points, tools_used, raw_chars, compressed_chars
         FROM conversations ${where} ORDER BY date DESC LIMIT ?`,
    );
    const rows = stmt.all(...params, limit) as Array<{
        date: string;
        summary: string;
        category: string;
        key_points: string;
        tools_used: string;
        raw_chars: number;
        compressed_chars: number;
    }>;

    return rows.map((r) => ({
        date: r.date,
        summary: r.summary,
        category: r.category,
        keyPoints: r.key_points ? r.key_points.split("; ") : [],
        toolsUsed: r.tools_used ? r.tools_used.split(", ") : [],
        rawChars: r.raw_chars,
        compressedChars: r.compressed_chars,
    }));
}

/** 搜索对话记录（全文匹配 summary 和 key_points） */
export function searchConversations(query: string, limit = 20): ConversationRecord[] {
    const db = getDB();
    const stmt = db.prepare(
        `SELECT date, summary, category, key_points, tools_used, raw_chars, compressed_chars
         FROM conversations
         WHERE summary LIKE ? OR key_points LIKE ?
         ORDER BY date DESC LIMIT ?`,
    );
    const likePattern = `%${query}%`;
    const rows = stmt.all(likePattern, likePattern, limit) as Array<{
        date: string;
        summary: string;
        category: string;
        key_points: string;
        tools_used: string;
        raw_chars: number;
        compressed_chars: number;
    }>;

    return rows.map((r) => ({
        date: r.date,
        summary: r.summary,
        category: r.category,
        keyPoints: r.key_points ? r.key_points.split("; ") : [],
        toolsUsed: r.tools_used ? r.tools_used.split(", ") : [],
        rawChars: r.raw_chars,
        compressedChars: r.compressed_chars,
    }));
}

/** 获取数据库统计信息 */
export function getDBStats(): {
    conversationCount: number;
    snapshotCount: number;
    totalRawChars: number;
    totalCompressedChars: number;
    dbSizeKB: number;
    oldestDate: string;
    newestDate: string;
} {
    const db = getDB();

    const countRow = db.prepare("SELECT COUNT(*) as count FROM conversations").get() as {
        count: number;
    };
    const snapshotRow = db.prepare("SELECT COUNT(*) as count FROM memory_snapshots").get() as {
        count: number;
    };
    const sumRow = db.prepare(
        "SELECT COALESCE(SUM(raw_chars),0) as rawChars, COALESCE(SUM(compressed_chars),0) as compressedChars FROM conversations",
    ).get() as { rawChars: number; compressedChars: number };
    const oldestRow = db.prepare("SELECT MIN(date) as d FROM conversations").get() as {
        d: string | null;
    };
    const newestRow = db.prepare("SELECT MAX(date) as d FROM conversations").get() as {
        d: string | null;
    };

    let dbSizeKB = 0;
    try {
        const stat = statSync(DB_PATH);
        dbSizeKB = Math.round(stat.size / 1024);
    } catch {
        // ignore
    }

    return {
        conversationCount: countRow.count,
        snapshotCount: snapshotRow.count,
        totalRawChars: sumRow.rawChars,
        totalCompressedChars: sumRow.compressedChars,
        dbSizeKB,
        oldestDate: oldestRow.d ?? "-",
        newestDate: newestRow.d ?? "-",
    };
}

// ── MEMORY.md / USER.md 轻量压缩 ──────────────────────────────

/**
 * 对 MEMORY.md 或 USER.md 执行轻量压缩：
 * - 保留标题结构
 * - 对过长的段落进行截断
 * - 保留所有 key-value 行
 */
export async function lightCompress(fileName: string): Promise<{
    originalChars: number;
    compressedChars: number;
}> {
    const filePath = path.join(MEMORIES_DIR, fileName);
    let content: string;
    try {
        content = await fs.readFile(filePath, "utf-8");
    } catch {
        return { originalChars: 0, compressedChars: 0 };
    }

    const originalChars = content.length;
    const threshold = CHAR_THRESHOLDS[fileName] ?? 10_000;

    if (originalChars <= threshold) {
        return { originalChars, compressedChars: originalChars };
    }

    // 压缩策略：保留所有标题行和列表行，压缩长段落
    const lines = content.split("\n");
    const compressed: string[] = [];
    let consecutiveText = 0;

    for (const line of lines) {
        const trimmed = line.trim();

        // 标题、列表、引用行始终保留
        if (
            /^#+\s/.test(trimmed) ||
            /^[-*]\s/.test(trimmed) ||
            /^\d+[.)]\s/.test(trimmed) ||
            trimmed.startsWith(">") ||
            trimmed === ""
        ) {
            compressed.push(line);
            consecutiveText = 0;
            continue;
        }

        // 连续正文行过多时跳过中间行
        consecutiveText++;
        if (consecutiveText > 5) {
            if (consecutiveText === 6) {
                compressed.push("> …（中间内容已压缩）…");
            }
            continue;
        }
        compressed.push(line);
    }

    const result = compressed.join("\n");

    // 创建快照再覆盖
    const db = getDB();
    db.prepare(
        "INSERT INTO memory_snapshots (file_name, content_snapshot, char_count) VALUES (?, ?, ?)",
    ).run(fileName, content, originalChars);

    await fs.writeFile(filePath, result, "utf-8");
    return { originalChars, compressedChars: result.length };
}

// ── 统一的自动处理入口 ────────────────────────────────────────

/**
 * 自动检测 + 处理：扫描所有 .md 文件，对超阈值文件执行相应操作。
 *
 * - HISTORY.md 超过阈值 → SQLite 归档管道
 * - MEMORY.md / USER.md 超过阈值 → 轻量压缩
 *
 * 每轮对话结束后由 Agent 循环自动调用（被动触发）。
 */
export async function autoProcess(): Promise<string[]> {
    const logs: string[] = [];
    const checks = await checkThresholds();
    const oversized = checks.filter((c) => c.needsAction);

    if (oversized.length === 0) return logs;

    for (const check of oversized) {
        if (check.file === "HISTORY.md") {
            // HISTORY.md → SQLite 完整归档管道
            try {
                const result = await processHistoryPipeline();
                logs.push(
                    `📦 HISTORY.md 归档: ${result.recordsStored} 条 → conversations.db ` +
                        `(${(result.originalChars / 1024).toFixed(0)}KB → ${(result.compressedChars / 1024).toFixed(0)}KB)`,
                );
            } catch (e) {
                logs.push(`❌ HISTORY.md 归档失败: ${e instanceof Error ? e.message : String(e)}`);
            }
        } else {
            // MEMORY.md / USER.md → 轻量压缩
            try {
                const result = await lightCompress(check.file);
                if (result.originalChars !== result.compressedChars) {
                    logs.push(
                        `📦 ${check.file} 压缩: ` +
                            `${(result.originalChars / 1024).toFixed(0)}KB → ${(result.compressedChars / 1024).toFixed(0)}KB`,
                    );
                }
            } catch (e) {
                logs.push(`❌ ${check.file} 压缩失败: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    return logs;
}

/**
 * 启动时调用：初始化数据库并打印统计信息。
 */
export function initHistoryManager(): void {
    try {
        const db = getDB();
        const countRow = db.prepare("SELECT COUNT(*) as count FROM conversations").get() as {
            count: number;
        };
        console.log(
            `[history-manager] SQLite 就绪: ${DB_PATH} (${countRow.count} 条历史记录)`,
        );
    } catch (e) {
        console.warn(
            `[history-manager] 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
}
