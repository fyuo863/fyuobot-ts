// src/memory/history-manager.ts
//
// HistoryManager —— 双层对话历史存储。
//
// 架构：
//   HISTORY.md  →  save_turn 被动追加原始对话（agent 不可见）
//                  ↓ 超过 MAX_BUFFER_CHARS
//                LLM 批量浓缩 → SQLite
//                  ↓
//   history.db (SQLite)  ← 持久化归档

// ── 类型 ──────────────────────────────────────────────────────

/** 单次工具调用记录 */
export interface ToolCallRecord {
    name: string;
    args: Record<string, unknown>;
    /** 工具执行结果（可能被截断） */
    result: string;
}

interface UserFact {
    last_confirmed: string;
    fact: string;
}

type UserMemorySection =
    | "Current Preferences"
    | "Environment"
    | "Projects"
    | "Historical Notes";

type ParsedUserMemory = Record<UserMemorySection, string[]>;
//
//   每次程序启动自动开启新会话；浓缩在后台线程执行。

import { DatabaseSync } from "node:sqlite";
import * as fs from "fs/promises";
import { mkdirSync, statSync, readFileSync, openSync, writeSync, closeSync, appendFileSync, writeFileSync } from "fs";
import * as path from "path";
import "dotenv/config";
import OpenAI from "openai";
import {
    compressContent,
    MEMORY_FILE_SIZE_THRESHOLD,
} from "../tools/compress-tool.js";

// ── LLM 客户端（用于批量浓缩，非流式调用）─────────────────────

const llmClient = new OpenAI({
    apiKey: process.env.THIRD_PARTY_API_KEY,
    baseURL: process.env.THIRD_PARTY_BASE_URL,
});
const targetModel = process.env.THIRD_PARTY_MODEL || "gpt-3.5-turbo";

// ════════════════════════════════════════════════════════════════
// HistoryManager 单例
// ════════════════════════════════════════════════════════════════

export class HistoryManager {
    static DB_FILENAME = "history.db";
    static HISTORY_REL_PATH = ".fyuobot/memories/HISTORY.md";
    static USER_REL_PATH = ".fyuobot/memories/USER.md";
    static MEMORY_REL_PATH = ".fyuobot/memories/MEMORY.md";
    static MAX_BUFFER_CHARS = 15_000; // HISTORY.md 超过此值触发浓缩
    static KEEP_RECENT_CHARS = 3_000; // 浓缩后保留最近的原始对话

    // ── 单例 ──────────────────────────────────────────────

    private static _instance: HistoryManager | null = null;

    static instance(workspace?: string): HistoryManager {
        if (!HistoryManager._instance) {
            HistoryManager._instance = new HistoryManager(
                workspace ?? process.cwd(),
            );
        }
        return HistoryManager._instance;
    }

    /** 用于启动时显式初始化（创建会话 + 检查是否需要浓缩） */
    static init(workspace?: string): HistoryManager {
        return HistoryManager.instance(workspace);
    }

    // ── 实例字段 ──────────────────────────────────────────

    private dbPath: string;
    private historyPath: string;
    private userPath: string;
    private memoryPath: string;
    private sessionStart: string;
    private condensing = false; // 简易互斥锁（单线程 JS 足够）
    private lastCondenseRequestAt = 0;
    private sessionHeaderWritten = false; // 延迟写入：首次 saveTurn() 时才写会话头部
    private db: DatabaseSync | null = null; // 单例连接

    private constructor(workspace: string) {
        const dbDir = path.join(workspace, ".fyuobot", "history");
        mkdirSync(dbDir, { recursive: true });
        this.dbPath = path.join(dbDir, HistoryManager.DB_FILENAME);
        this.historyPath = path.join(workspace, HistoryManager.HISTORY_REL_PATH);
        this.userPath = path.join(workspace, HistoryManager.USER_REL_PATH);
        this.memoryPath = path.join(workspace, HistoryManager.MEMORY_REL_PATH);

        this.sessionStart = new Date().toLocaleString("zh-CN");

        this.#initDB();
        // 启动时检查是否需要浓缩（不写会话头部，延迟到首次用户输入）
        this.checkAndCondense();
    }

    // ════════════════════════════════════════════════════════
    // SQLite
    // ════════════════════════════════════════════════════════

    #getConn(): DatabaseSync {
        if (!this.db) {
            this.db = new DatabaseSync(this.dbPath);
            this.db.exec("PRAGMA journal_mode=WAL");
        }
        return this.db;
    }

    #initDB(): void {
        const conn = this.#getConn();

        // 检查旧 schema 是否存在需要迁移的列
        const cursor = conn.prepare("PRAGMA table_info(conversations)");
        const columns = new Set<string>();
        for (const row of cursor.all() as Array<{ name: string }>) {
            columns.add(row.name);
        }

        // 如果存在旧 schema 的 "date" 列（非 session_id），重建表
        if (columns.has("date") && !columns.has("session_id")) {
            conn.exec("DROP TABLE IF EXISTS conversations");
        }

        conn.exec(`
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL DEFAULT '',
                timestamp REAL NOT NULL,
                topic TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL
            )
        `);

        // 确保索引存在
        for (const idx of ["session_id", "timestamp", "topic"]) {
            conn.exec(
                `CREATE INDEX IF NOT EXISTS idx_conv_${idx} ON conversations(${idx})`,
            );
        }
    }

    #insertCondensed(entries: Array<{ session?: string; time_span?: string; topic: string; summary: string }>): void {
        const conn = this.#getConn();
        const insert = conn.prepare(
            "INSERT INTO conversations (session_id, timestamp, topic, summary) VALUES (?, ?, ?, ?)",
        );
        
        for (const entry of entries) {
            let tsSeconds = Date.now() / 1000;
            
            // 安全提取时间跨度中的最后一个日期
            if (entry.time_span) {
                const parts = entry.time_span.split('-');
                const lastDateStr = parts[parts.length - 1];
                
                // 增加判空检查，解决 Object is possibly 'undefined'
                if (lastDateStr) {
                    const parsedTs = Date.parse(lastDateStr.trim());
                    if (!isNaN(parsedTs)) {
                        tsSeconds = parsedTs / 1000;
                    }
                }
            }

            // 将 time_span 拼接到 summary 头部，确保检索时 agent 能看到时间周期
            const finalSummary = entry.time_span 
                ? `[${entry.time_span}] ${entry.summary}` 
                : entry.summary;

            insert.run(
                entry.session ?? "",
                tsSeconds,
                entry.topic ?? "",
                finalSummary,
            );
        }
    }

    // ════════════════════════════════════════════════════════
    // HISTORY.md 缓冲区
    // ════════════════════════════════════════════════════════

    /** 确保会话头部已写入（延迟到首次用户输入时） */
    #ensureSessionHeader(): void {
        if (this.sessionHeaderWritten) return;

        const existing = this.#readHistory();
        const count = (existing.match(/\n## 会话 /g)?.length ?? 0) + 1;

        const header = `\n## 会话 #${count} — ${this.sessionStart}\n\n`;
        this.#appendRaw(header);

        this.sessionHeaderWritten = true;
    }

    /** 开始新会话（供 /new 等重置操作调用）。
     *  重置头部标志，下次 saveTurn() 将写入新的会话头部。 */
    startNewSession(): void {
        this.sessionStart = new Date().toLocaleString("zh-CN");
        this.sessionHeaderWritten = false;
    }

    #readHistory(): string {
        try {
            return readFileSync(this.historyPath, "utf-8");
        } catch {
            return "";
        }
    }

    #appendRaw(text: string): void {
        const dir = path.dirname(this.historyPath);
        mkdirSync(dir, { recursive: true });
        // 同步写入确保原子性（Node 单线程安全）
        try {
            const fd = openSync(this.historyPath, "a");
            writeSync(fd, text);
            closeSync(fd);
        } catch {
            // fallback
            appendFileSync(this.historyPath, text, "utf-8");
        }
    }

    #bufferSize(): number {
        return this.#readHistory().length;
    }

    // ════════════════════════════════════════════════════════
    // 保存对话（被动，无 LLM）
    // ════════════════════════════════════════════════════════

    /**
     * 被动保存一轮原始对话到 HISTORY.md。
     * 由 agent 在每轮对话结束后自动调用。
     *
     * @param tools  本轮中 LLM 调用的工具及其输入/输出（可选）
     */
    saveTurn(
        _sessionId: string,
        userInput: string,
        agentResponse: string,
        tools?: ToolCallRecord[],
    ): void {
        this.#ensureSessionHeader();

        const ts = new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
        });

        const parts: string[] = [`[${ts}]`, `User: ${userInput}`];

        // 工具调用记录（仅保存输入，不保存输出）
        if (tools && tools.length > 0) {
            for (const tc of tools) {
                const argsSummary = JSON.stringify(tc.args);
                parts.push(`Tool: ${tc.name}(${argsSummary})`);
            }
        }

        parts.push(`Agent: ${agentResponse}`, "");

        const entry = parts.join("\n") + "\n";
        this.#appendRaw(entry);

        // 检查是否需要浓缩（异步，不阻塞对话）
        if (this.#bufferSize() > HistoryManager.MAX_BUFFER_CHARS) {
            this.#safeCondense();
        }
    }

    #safeCondense(): void {
        const now = Date.now();
        if (now - this.lastCondenseRequestAt < 1500) return;
        this.lastCondenseRequestAt = now;

        // 简易互斥：防止并发浓缩
        if (this.condensing) return;
        this.condensing = true;
        try {
            this.#condenseBuffer();
        } finally {
            this.condensing = false;
        }
    }

    // ════════════════════════════════════════════════════════
    // 批量浓缩
    // ════════════════════════════════════════════════════════

    static BATCH_CONDENSE_PROMPT = [
        "你是一个高级的对话历史归档与记忆提取引擎。以下是跨多个会话的完整对话记录。",
        "请仔细阅读并同时完成两个任务：",
        "",
        "【任务一：浓缩历史 (conversations)】",
        "1. 按话题分类，将相关的多轮对话归为一组，忽略纯寒暄。",
        "2. 每组用 1-3 句中文浓缩核心信息，分配 2-5 字的标签(topic)。",
        "3. 如果该话题跨越了多个时间点，请提取它的时间跨度（如 2026/6/5 10:00 - 2026/6/6 15:30）；如果是单次对话，只需记录单个时间。",
        "",
        "【任务二：提取长期记忆 (user_facts)】",
        "1. 只提取对未来多个会话仍然成立、值得长期记住的用户事实：如沟通语言、注释/代码风格、确认偏好、稳定开发习惯、稳定操作系统/终端/默认目录，以及用户明确表达且长期成立的个人口味/饮食偏好、常用应用、设备偏好、作息/提醒习惯、常访问网站。",
        "2. 严禁写入 user_facts 的内容：临时任务、一次性调试过程、正在进行的实现细节、项目/仓库/技能/模型/工作流名称、一次性的娱乐行为、推测性事实（如“可能…”、“推断…”）。",
        "3. 将保留的信息提取为简洁陈述句。如果同一偏好曾发生变更，只保留最新、最终确认的事实，并提取该事实最终确立的具体日期。",
        "4. 如果这段对话中没有新的稳定用户事实，返回空数组 []。",
        "",
        "你必须严格返回以下 JSON 对象格式：",
        "{",
        '  "conversations": [{"time_span": "2026/6/5-2026/6/6", "topic": "标签", "summary": "摘要"}],',
        '  "user_facts": [{"last_confirmed": "2026/6/6", "fact": "提取的偏好 1"}]',
        "}",
        "注意：必须输出标准 JSON，字段名和字符串一律使用英文双引号，不要输出 Markdown 代码块或额外说明。",
        "",
        "=== 对话记录 ===",
    ].join("\n");

    #condenseBuffer(): void {
        const content = this.#readHistory();
        if (content.length <= HistoryManager.KEEP_RECENT_CHARS) return;

        // 拆分为「待浓缩」和「待保留」两部分
        const toKeep = content.slice(-HistoryManager.KEEP_RECENT_CHARS);
        const toCondense = content.slice(0, -HistoryManager.KEEP_RECENT_CHARS);

        if (toCondense.length < 500) return;

        console.log("  [历史] 正在批量浓缩...");

        // 注入当前真实时间作为 LLM 的时间锚点
        const currentTimeStr = new Date().toLocaleString("zh-CN");
        const systemTimePrompt = `【系统当前真实时间】：${currentTimeStr}\n\n`;

        // 仅取尾部避免超 token 限制（最多 12K 字符）
        const condenseInput = toCondense.slice(-12_000);
        const prompt = systemTimePrompt + HistoryManager.BATCH_CONDENSE_PROMPT + condenseInput;

        this.#callLLMCondense(prompt, toKeep);
    }

    async #callLLMCondense(prompt: string, toKeep: string): Promise<void> {
        try {
            const response = await llmClient.chat.completions.create({
                model: targetModel,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3, // 保持低温度以确保 JSON 稳定
                stream: false,
            });

            const text = response.choices[0]?.message?.content?.trim() ?? "";
            const { conversations, facts } = this.#parseBatchResult(text);
            
            // 1. 存储浓缩历史到 SQLite
            if (conversations.length > 0) {
                this.#insertCondensed(conversations);
                console.log(`  [历史] 归档了 ${conversations.length} 条话题记录`);
            }

            // 2. 存储长期记忆到 USER.md
            if (facts.length > 0) {
                try {
                    const kept = this.#mergeUserFacts(facts);
                    if (kept > 0) {
                        this.#condenseUserMemory();
                        console.log(`  [user] 保存了 ${kept} 条稳定用户事实到 USER.md`);
                    } else {
                        console.log(`  [user] 跳过了 ${facts.length} 条低价值或临时用户事实`);
                    }
                } catch (err) {
                    console.warn(`  [user] 写入 USER.md 失败: ${err}`);
                }
            }

            // 删除已浓缩内容，仅保留最近原始对话
            let finalKeep = toKeep;
            const boundary = toKeep.indexOf("\n## 会话 ");
            if (boundary > 0) {
                finalKeep = toKeep.slice(boundary);
            }
            await fs.writeFile(this.historyPath, finalKeep, "utf-8");
            
        } catch (e) {
            console.log(`  [历史] 批量浓缩失败: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    #parseBatchResult(text: string): { 
        conversations: Array<{ time_span?: string; topic: string; summary: string }>; 
        facts: Array<{ last_confirmed: string; fact: string }> 
    } {
        // 清理 markdown 代码块
        let cleaned = text;
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.split("\n").slice(1).join("\n");
            if (cleaned.endsWith("```")) {
                cleaned = cleaned.slice(0, -3);
            }
            cleaned = cleaned.trim();
        }

        const defaultResult = { conversations: [], facts: [] };

        // 尝试严格的 JSON 解析
        try {
            const data = JSON.parse(cleaned);
            if (typeof data === "object" && data !== null) {
                const conversations = Array.isArray(data.conversations)
                    ? data.conversations.filter(
                          (e: any) => typeof e === "object" && e !== null && typeof e.summary === "string" && e.summary.length > 0
                      ).map((e: any) => ({ // 显式声明 e: any
                          time_span: String(e.time_span || ""),
                          topic: String(e.topic || ""),
                          summary: String(e.summary)
                      }))
                    : [];
                    
                const facts = Array.isArray(data.user_facts)
                    ? data.user_facts.filter(
                          (f: any) => typeof f === "object" && f !== null && typeof f.fact === "string" && f.fact.length > 0
                      ).map((f: any) => ({ // 显式声明 f: any
                          last_confirmed: String(f.last_confirmed || ""),
                          fact: String(f.fact)
                      }))
                    : [];
                    
                return { conversations, facts };
            }
        } catch {
            console.warn("  [历史] JSON 解析失败，尝试降级解析。");
            return { conversations: this.#parseBatchFallback(cleaned), facts: [] };
        }

        return defaultResult;
    }

    #parseBatchFallback(text: string): Array<{ time_span?: string; topic: string; summary: string }> {
        const entries: Array<{ time_span?: string; topic: string; summary: string }> = [];
        const blockRegex = /\{[^}]*\}/g;
        let match: RegExpExecArray | null;
        while ((match = blockRegex.exec(text)) !== null) {
            const block = match[0];
            const timeM = /"time_span"\s*:\s*"([^"]*)"/.exec(block);
            const topicM = /"topic"\s*:\s*"([^"]*)"/.exec(block);
            const summaryStart = /"summary"\s*:\s*"/.exec(block);
            if (summaryStart) {
                const startIdx = summaryStart.index + summaryStart[0].length;
                const rest = block.slice(startIdx);
                const lastClose = rest.lastIndexOf('"}');
                const summary = lastClose >= 0 ? rest.slice(0, lastClose) : rest.trim().replace(/"\s*\}$/, "");
                if (summary.trim()) {
                    entries.push({
                        time_span: timeM?.[1] ?? "",
                        topic: topicM?.[1] ?? "",
                        summary: summary.trim(),
                    });
                }
            }
        }
        return entries;
    }

    // ════════════════════════════════════════════════════════
    // 搜索
    // ════════════════════════════════════════════════════════

    /** 关键词搜索 SQLite 浓缩历史 */
    search(query: string, limit = 5): string {
        const conn = this.#getConn();
        const rows = conn
            .prepare(
                "SELECT session_id, timestamp, topic, summary FROM conversations " +
                    "WHERE summary LIKE ? OR topic LIKE ? " +
                    "ORDER BY timestamp DESC LIMIT ?",
            )
            .all(`%${query}%`, `%${query}%`, limit) as Array<{
            session_id: string;
            timestamp: number;
            topic: string;
            summary: string;
        }>;

        if (rows.length === 0) {
            return `未找到与 '${query}' 相关的历史记录。`;
        }

        const lines = [`搜索 '${query}' 找到 ${rows.length} 条记录：`];
        for (const row of rows) {
            const timeStr = new Date(row.timestamp * 1000).toLocaleString("zh-CN");
            const topicStr = row.topic ? ` [${row.topic}]` : "";
            lines.push(`[${timeStr}]${topicStr} (${row.session_id}): ${row.summary}`);
        }
        return lines.join("\n");
    }

    /** 获取最近记录：先查 SQLite，再补 HISTORY.md 最新原始对话 */
    getRecent(limit = 10): string {
        const parts: string[] = [];

        // SQLite 浓缩记录
        const conn = this.#getConn();
        const rows = conn
            .prepare(
                "SELECT topic, summary FROM conversations ORDER BY timestamp DESC LIMIT ?",
            )
            .all(limit) as Array<{ topic: string; summary: string }>;

        if (rows.length > 0) {
            parts.push("=== 浓缩历史 ===");
            for (const row of [...rows].reverse()) {
                const topicStr = row.topic ? ` [${row.topic}]` : "";
                parts.push(`${topicStr} ${row.summary}`);
            }
        }

        // HISTORY.md 最近原始对话
        const raw = this.#readHistory();
        if (raw) {
            const sessions = raw.split("\n## 会话 ");
            const recentSessions = sessions.slice(-2);
            const recentText = "\n## 会话 ".repeat(recentSessions.length > 1 ? 1 : 0) + recentSessions.join("\n## 会话 ");
            const lines = recentText.trim().split("\n");
            const tail = lines.slice(-30).join("\n");
            if (tail.trim()) {
                parts.push("\n=== 最近原始对话 ===");
                parts.push(tail);
            }
        }

        return parts.length > 0 ? parts.join("\n") : "暂无历史记录。";
    }

    /** 兼容旧接口 */
    getRecentHistory(limit = 10): string {
        return this.getRecent(limit);
    }

    /** 获取数据库统计信息 */
    getStats(): {
        conversationCount: number;
        dbSizeKB: number;
        oldestDate: string;
        newestDate: string;
    } {
        const conn = this.#getConn();
        const countRow = conn.prepare("SELECT COUNT(*) as count FROM conversations").get() as { count: number };
        const oldestRow = conn.prepare("SELECT MIN(timestamp) as d FROM conversations").get() as { d: number | null };
        const newestRow = conn.prepare("SELECT MAX(timestamp) as d FROM conversations").get() as { d: number | null };

        let dbSizeKB = 0;
        try {
            const stat = statSync(this.dbPath);
            dbSizeKB = Math.round(stat.size / 1024);
        } catch {
            // ignore
        }

        return {
            conversationCount: countRow.count,
            dbSizeKB,
            oldestDate: oldestRow.d ? new Date(oldestRow.d * 1000).toLocaleString("zh-CN") : "-",
            newestDate: newestRow.d ? new Date(newestRow.d * 1000).toLocaleString("zh-CN") : "-",
        };
    }

    // ════════════════════════════════════════════════════════
    // 缓冲区状态
    // ════════════════════════════════════════════════════════

    /** 获取 HISTORY.md 的字符统计 */
    getBufferStats(): { exists: boolean; charCount: number; threshold: number; percentUsed: number } {
        try {
            const content = readFileSync(this.historyPath, "utf-8");
            const charCount = content.length;
            return {
                exists: true,
                charCount,
                threshold: HistoryManager.MAX_BUFFER_CHARS,
                percentUsed: Math.round((charCount / HistoryManager.MAX_BUFFER_CHARS) * 100),
            };
        } catch {
            return { exists: false, charCount: 0, threshold: HistoryManager.MAX_BUFFER_CHARS, percentUsed: 0 };
        }
    }

    /** 触发浓缩检查（公开，供手动/定时调用） */
    getUserMemoryStats(): { exists: boolean; charCount: number; threshold: number; percentUsed: number } {
        try {
            const content = readFileSync(this.userPath, "utf-8");
            const charCount = Buffer.byteLength(content, "utf-8");
            return {
                exists: true,
                charCount,
                threshold: MEMORY_FILE_SIZE_THRESHOLD,
                percentUsed: Math.round((charCount / MEMORY_FILE_SIZE_THRESHOLD) * 100),
            };
        } catch {
            return { exists: false, charCount: 0, threshold: MEMORY_FILE_SIZE_THRESHOLD, percentUsed: 0 };
        }
    }

    getSystemMemoryStats(): { exists: boolean; charCount: number; threshold: number; percentUsed: number } {
        try {
            const content = readFileSync(this.memoryPath, "utf-8");
            const charCount = Buffer.byteLength(content, "utf-8");
            return {
                exists: true,
                charCount,
                threshold: MEMORY_FILE_SIZE_THRESHOLD,
                percentUsed: Math.round((charCount / MEMORY_FILE_SIZE_THRESHOLD) * 100),
            };
        } catch {
            return { exists: false, charCount: 0, threshold: MEMORY_FILE_SIZE_THRESHOLD, percentUsed: 0 };
        }
    }

    #mergeUserFacts(facts: UserFact[]): number {
        const fallbackDate = new Date().toLocaleDateString("zh-CN");
        const existing = this.#sanitizeUserMemory(
            this.#parseUserMemory(this.#readUserMemory()),
        );
        let keptCount = 0;

        for (const fact of facts) {
            const text = fact.fact.trim();
            if (!text) continue;
            if (!this.#shouldKeepUserFact(text)) continue;

            const date = fact.last_confirmed?.trim() || fallbackDate;
            const section = this.#classifyUserFact(text);
            if (!section) continue;
            const normalized = this.#userFactKey(text);
            const line = `- [${date}] ${text}`;

            const current = existing[section];
            const duplicateIndex = current.findIndex(
                (entry) => this.#userFactKey(entry) === normalized,
            );

            if (duplicateIndex >= 0) {
                current[duplicateIndex] = line;
            } else {
                current.push(line);
            }

            keptCount += 1;
        }

        mkdirSync(path.dirname(this.userPath), { recursive: true });
        writeFileSync(this.userPath, this.#formatUserMemory(existing), "utf-8");
        return keptCount;
    }

    #readUserMemory(): string {
        try {
            return readFileSync(this.userPath, "utf-8");
        } catch {
            return "";
        }
    }

    #emptyUserMemory(): ParsedUserMemory {
        return {
            "Current Preferences": [],
            Environment: [],
            Projects: [],
            "Historical Notes": [],
        };
    }

    #parseUserMemory(content: string): ParsedUserMemory {
        const parsed = this.#emptyUserMemory();
        let current: UserMemorySection = "Current Preferences";

        for (const line of content.split(/\r?\n/)) {
            const heading = /^##\s+(.+?)\s*$/.exec(line);
            if (heading) {
                const section = this.#toUserMemorySection(heading[1] ?? "");
                if (section) current = section;
                continue;
            }

            const trimmed = line.trim();
            if (!trimmed || trimmed === "# User Memory") continue;
            if (trimmed.startsWith("- ")) {
                parsed[current].push(trimmed);
            } else if (!trimmed.startsWith("#") && !trimmed.startsWith(">")) {
                parsed[current].push(`- ${trimmed}`);
            }
        }

        return this.#dedupeUserMemory(parsed);
    }

    #formatUserMemory(memory: ParsedUserMemory): string {
        const sections: UserMemorySection[] = [
            "Current Preferences",
            "Environment",
        ];

        const lines = [
            "# User Memory",
            "",
            "> This file is maintained automatically. Keep durable user facts here; historical conversation details stay in SQLite.",
        ];

        for (const section of sections) {
            lines.push("", `## ${section}`);
            const entries = memory[section];
            if (entries.length === 0) {
                lines.push("- (none)");
            } else {
                lines.push(...entries);
            }
        }

        return `${lines.join("\n")}\n`;
    }

    #dedupeUserMemory(memory: ParsedUserMemory): ParsedUserMemory {
        const deduped = this.#emptyUserMemory();
        for (const section of Object.keys(deduped) as UserMemorySection[]) {
            const byKey = new Map<string, string>();
            for (const entry of memory[section]) {
                if (entry === "- (none)") continue;
                byKey.set(this.#userFactKey(entry), entry);
            }
            deduped[section] = [...byKey.values()];
        }
        return deduped;
    }

    #sanitizeUserMemory(memory: ParsedUserMemory): ParsedUserMemory {
        const sanitized = this.#emptyUserMemory();

        for (const section of Object.keys(memory) as UserMemorySection[]) {
            for (const entry of memory[section]) {
                if (entry === "- (none)") continue;

                const text = this.#extractUserFactText(entry);
                if (!this.#shouldKeepUserFact(text)) continue;

                const targetSection = this.#classifyUserFact(text);
                if (!targetSection) continue;

                sanitized[targetSection].push(entry.trim());
            }
        }

        return this.#dedupeUserMemory(sanitized);
    }

    #toUserMemorySection(value: string): UserMemorySection | undefined {
        const normalized = value.trim().toLowerCase();
        if (normalized === "current preferences") return "Current Preferences";
        if (normalized === "environment") return "Environment";
        if (normalized === "projects") return "Projects";
        if (normalized === "historical notes") return "Historical Notes";
        return undefined;
    }

    #classifyUserFact(fact: string): UserMemorySection | undefined {
        if (this.#isStableEnvironmentFact(fact)) {
            return "Environment";
        }
        if (this.#isStablePersonalHabitFact(fact)) {
            return "Current Preferences";
        }
        if (this.#isPersonalTastePreferenceFact(fact)) {
            return "Current Preferences";
        }
        if (this.#isActionableUserPreferenceFact(fact)) {
            return "Current Preferences";
        }
        return undefined;
    }

    #shouldKeepUserFact(fact: string): boolean {
        const text = this.#extractUserFactText(fact);
        if (!text) return false;
        if (this.#looksSpeculativeUserFact(text)) return false;
        if (this.#looksTransientUserFact(text)) return false;
        if (this.#looksLikeProjectOrSystemFact(text)) return false;

        return (
            this.#isStablePersonalHabitFact(text) ||
            this.#isPersonalTastePreferenceFact(text) ||
            this.#isActionableUserPreferenceFact(text) ||
            this.#isStableEnvironmentFact(text)
        );
    }

    #looksSpeculativeUserFact(fact: string): boolean {
        return /(可能|推断|猜测|疑似|大概|也许|似乎|probably|maybe|seems)/i.test(
            fact,
        );
    }

    #looksTransientUserFact(fact: string): boolean {
        return /(正在|刚刚|刚才|临时|一次性|曾(?:经)?|创建了|开发了|测试|初始化|调试|排查|修复中|部署在|启动了|打开了|关闭了|安装了|搜索了|下载了|访问了|游玩|玩过|关注)/.test(
            fact,
        );
    }

    #looksLikeProjectOrSystemFact(fact: string): boolean {
        return /(仓库|repo|repository|技能|skill|workflow|工作流|github|gitlab|模型|model|baseurl|api|提示词|prompt|记忆系统|代码库|博客|路由|架构|部署|ecs|redis|postgres|docker|mcp|fyuobot|setup-architecture|coding-workflow|deepseek)/i.test(
            fact,
        );
    }

    #isActionableUserPreferenceFact(fact: string): boolean {
        return /(中文|language|语言|沟通|交流|回复|注释|comment|代码风格|风格|格式|确认|approval|codegraph|命令兼容|taskkill|stop-process|子agent|sub-agent|默认下载目录|下载目录)/i.test(
            fact,
        );
    }

    #isPersonalTastePreferenceFact(fact: string): boolean {
        const hasPreferenceVerb = /(喜欢|不喜欢|讨厌|爱吃|爱喝|偏爱|常喝|常吃|忌口|过敏|口味|饮食偏好)/.test(
            fact,
        );
        const hasFoodContext = /(吃|喝|饮食|食物|水果|蔬菜|零食|饮料|咖啡|茶|甜|咸|辣|酸|苦|忌口|过敏|西瓜|冬瓜|芹菜)/.test(
            fact,
        );
        return hasPreferenceVerb && hasFoodContext;
    }

    #isStablePersonalHabitFact(fact: string): boolean {
        const hasPreferenceVerb = /(喜欢|偏好|习惯|通常|经常|总是|常用|主要用|默认用|收藏|常去|订阅|关注|提醒我|记得提醒|作息|睡觉|起床|午休|通知)/.test(
            fact,
        );
        const hasHabitContext = /(应用|app|软件|程序|浏览器|编辑器|ide|终端|网站|网址|站点|设备|电脑|笔记本|手机|平板|耳机|键盘|鼠标|显示器|提醒|闹钟|通知|作息|睡觉|起床|午休|日程|calendar|邮箱|mail|spotify|youtube|bilibili|github|steam|factorio)/i.test(
            fact,
        );
        return hasPreferenceVerb && hasHabitContext;
    }

    #isStableEnvironmentFact(fact: string): boolean {
        return /(windows|linux|macos|powershell|shell|cmd|terminal|终端|操作系统|默认下载目录|下载目录|workspace|工作区)/i.test(
            fact,
        );
    }

    #extractUserFactText(value: string): string {
        return value
            .replace(/^-\s*/, "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .trim();
    }

    #userFactKey(value: string): string {
        const text = this.#extractUserFactText(value).replace(/\*\*/g, "");
        const lower = text.toLowerCase();

        if (/(中文|chinese)/i.test(text) && /(语言|沟通|交流|回复|language)/i.test(text)) {
            return "pref:language:zh";
        }
        if (/(中文|chinese)/i.test(text) && /(注释|comment)/i.test(text)) {
            return "pref:comment:zh";
        }
        if (/(代码风格|风格)/.test(text) && /(项目现有|现有风格|遵循)/.test(text)) {
            return "pref:style:follow-project";
        }
        if (/codegraph/.test(lower)) {
            return "pref:codegraph-first";
        }
        if (/(powershell|bash|linux|macos|命令兼容|专属命令)/i.test(text) && /(不要|避免|兼容|命令)/.test(text)) {
            return "pref:command-compat";
        }
        if (/(taskkill|stop-process)/i.test(text)) {
            return "pref:close-app-command";
        }
        if (/(子agent|sub-agent)/i.test(text)) {
            return "pref:background-subagent";
        }
        if (/(默认下载目录|下载目录)/.test(text)) {
            return "env:download-dir";
        }
        if (/(factorio|steam|spotify|youtube|bilibili|github|邮箱|mail|calendar|日程|提醒|闹钟|浏览器|编辑器|ide|终端|app|应用|设备|电脑|手机|键盘|鼠标|耳机)/i.test(text)) {
            return `personal:${this.#normalizeUserFact(text)}`;
        }

        const os = /(windows|linux|macos)/i.exec(text)?.[1]?.toLowerCase();
        if (os && /(操作系统|os|环境)/i.test(text)) {
            return `env:os:${os}`;
        }

        const shell = /(powershell|cmd|bash|zsh|fish)/i
            .exec(text)?.[1]
            ?.toLowerCase();
        if (shell && /(终端|shell|环境|命令)/i.test(text)) {
            return `env:shell:${shell}`;
        }

        return this.#normalizeUserFact(text);
    }

    #normalizeUserFact(value: string): string {
        return value
            .replace(/\*\*/g, "")
            .replace(/[，。！？,.!?;；:："'`[\]()（）]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    #condenseUserMemory(): boolean {
        return this.#condensePlainMemoryFile(this.userPath, "USER.md");
    }

    #condenseSystemMemory(): boolean {
        return this.#condensePlainMemoryFile(this.memoryPath, "MEMORY.md");
    }

    #condensePlainMemoryFile(filePath: string, label: string): boolean {
        let content: string;
        try {
            content = readFileSync(filePath, "utf-8");
        } catch {
            return false;
        }

        const originalSize = Buffer.byteLength(content, "utf-8");
        if (originalSize <= MEMORY_FILE_SIZE_THRESHOLD) return false;

        const { result, strategy } = compressContent(content, "auto");
        if (result === content) return false;

        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, result, "utf-8");

        const compressedSize = Buffer.byteLength(result, "utf-8");
        console.log(
            `  [memory] ${label} auto-compressed (${strategy}, ${(originalSize / 1024).toFixed(1)}KB -> ${(compressedSize / 1024).toFixed(1)}KB)`,
        );
        return true;
    }

    checkAndCondense(): boolean {
        let didCondense = false;
        if (this.#bufferSize() > HistoryManager.MAX_BUFFER_CHARS) {
            this.#safeCondense();
            didCondense = true;
        }
        if (this.#condenseUserMemory()) {
            didCondense = true;
        }
        if (this.#condenseSystemMemory()) {
            didCondense = true;
        }
        return didCondense;
    }
}
