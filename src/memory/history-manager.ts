// src/memory/history-manager.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import "dotenv/config";
import { compressContent, MEMORY_FILE_SIZE_THRESHOLD } from "../tools/compress-tool.js";

export interface ToolCallRecord {
    name: string;
    args: Record<string, unknown>;
    result: string;
}

interface UserFact {
    last_confirmed: string;
    fact: string;
}

interface SystemFact { last_confirmed: string; kind?: string; fact: string; }

interface TurnRow {
    date: string;
    time_24h: string;
    session_id: string;
    user_input: string;
    tool_names: string;
    agent_response: string;
}

interface ActivityRow {
    date: string;
    time_24h: string;
    session_id: string;
    title: string;
    tool_names: string;
    outcome: string;
}

type SystemFactKind = "user_method" | "agent_rule" | "agent_avoid";

type UserMemorySection = "Current Preferences" | "Environment" | "Projects" | "Historical Notes";

type ParsedUserMemory = Record<UserMemorySection, string[]>;

const DEFAULT_SYSTEM_MEMORY_CONTENT = [
    "# 系统设置",
    "",
    "> 此文件存储 Agent 的系统级配置与运行参数。",
    "> 由 memory 工具读写，agent 可在对话中调整。",
    "",
    "## 默认设置",
    "",
    "- **模型**: 由环境变量 THIRD_PARTY_MODEL 决定",
    "- **工具目录**: src/tools/",
    "- **MCP 配置**: .fyuobot/config.json",
].join("\n");
const AUTO_SYSTEM_MEMORY_START = "";
const AUTO_SYSTEM_MEMORY_END = "";
const AUTO_SYSTEM_MEMORY_HEADING = "## 自动归档经验";

export class HistoryManager {
    static DB_FILENAME = "history.db";
    static USER_REL_PATH = ".fyuobot/memories/USER.md";
    static MEMORY_REL_PATH = ".fyuobot/memories/MEMORY.md";

    // ── 正则规则配置库 ────────────────────────────────────
    private static readonly REGEX_SPECULATIVE = /(可能|推断|猜测|疑似|大概|也许|似乎|probably|maybe|seems)/i;
    private static readonly REGEX_TRANSIENT_USER = /(正在|刚刚|刚才|临时|一次性|曾(?:经)?|创建了|开发了|测试|初始化|调试|排查|修复中|部署在|启动了|打开了|关闭了|安装了|搜索了|下载了|访问了|游玩|玩过|关注)/;
    private static readonly REGEX_PROJECT_SYSTEM = /(仓库|repo|repository|技能|skill|workflow|工作流|github|gitlab|模型|model|baseurl|api|提示词|prompt|记忆系统|代码库|博客|路由|架构|部署|ecs|redis|postgres|docker|mcp|fyuobot|setup-architecture|coding-workflow|deepseek)/i;
    private static readonly REGEX_USER_PREF_ACTION = /(中文|language|语言|沟通|交流|回复|注释|comment|代码风格|风格|格式|确认|approval|codegraph|命令兼容|taskkill|stop-process|子agent|sub-agent|默认下载目录|下载目录)/i;
    private static readonly REGEX_USER_PREF_TASTE = /(喜欢|不喜欢|讨厌|爱吃|爱喝|偏爱|常喝|常吃|忌口|过敏|口味|饮食偏好)/;
    private static readonly REGEX_USER_PREF_FOOD = /(吃|喝|饮食|食物|水果|蔬菜|零食|饮料|咖啡|茶|甜|咸|辣|酸|苦|忌口|过敏|西瓜|冬瓜|芹菜)/;
    private static readonly REGEX_USER_HABIT_VERB = /(喜欢|偏好|习惯|通常|经常|总是|常用|主要用|默认用|收藏|常去|订阅|关注|提醒我|记得提醒|作息|睡觉|起床|午休|通知)/;
    private static readonly REGEX_USER_HABIT_CTX = /(应用|app|软件|程序|浏览器|编辑器|ide|终端|网站|网址|站点|设备|电脑|笔记本|手机|平板|耳机|键盘|鼠标|显示器|提醒|闹钟|通知|作息|睡觉|起床|午休|日程|calendar|邮箱|mail|spotify|youtube|bilibili|github|steam|factorio)/i;
    private static readonly REGEX_ENV_STABLE = /(windows|linux|macos|powershell|shell|cmd|terminal|终端|操作系统|默认下载目录|下载目录|workspace|工作区)/i;
    
    private static readonly REGEX_SYS_TRANSIENT = /(本次|这次|本轮|当前|刚刚|刚才|临时|一次性|试验|实验|修复中|排查中|暂时|为了这次|针对此|当前 issue|当前 bug)/i;
    private static readonly REGEX_SYS_RULE_DIR = /(优先|不要|避免|必须|应当|应该|先|而不是|改用|推荐|最好|先用|优先用|优先使用|不要再)/;
    private static readonly REGEX_SYS_RULE_CTX = /(codegraph|taskkill|stop-process|powershell|recent|search|sqlite|history|grep|rg|read|tool|工具|命令|关闭应用|查看代码结构|调用关系|搜索文件|下载文件|默认下载目录|读取最近对话|归档|压缩|中断|恢复输入框|浏览网页|绘图|折线图|everything)/i;
    private static readonly REGEX_SYS_METHOD_REP = /(用户|user).*(多次|经常|通常|习惯|总是|反复|优先|常用)/i;
    private static readonly REGEX_SYS_METHOD_CTX = /(使用|采用|先|再|搜索|下载|查看|关闭|打开|读取|写入|运行|调用|确认|选择|定位|浏览)/;
    private static readonly REGEX_SYS_MISTAKE_DIR = /(不要|避免|而不是|误用|错误方法|别再|不应)/;
    private static readonly REGEX_SYS_MISTAKE_CTX = /(agent|命令|工具|方法|步骤|search|recent|taskkill|stop-process|grep|bash|read|codegraph|sqlite|history)/i;

    // ── 实例字段 ──────────────────────────────────────────

    private static _instance: HistoryManager | null = null;
    private dbPath: string;
    private userPath: string;
    private memoryPath: string;
    private sessionId: string;
    private db: DatabaseSync | null = null; 

    static instance(workspace?: string): HistoryManager {
        if (!HistoryManager._instance) {
            HistoryManager._instance = new HistoryManager(workspace ?? process.cwd());
        }
        return HistoryManager._instance;
    }

    static init(workspace?: string): HistoryManager {
        return HistoryManager.instance(workspace);
    }

    private constructor(workspace: string) {
        const dbDir = path.join(workspace, ".fyuobot", "history");
        mkdirSync(dbDir, { recursive: true });
        this.dbPath = path.join(dbDir, HistoryManager.DB_FILENAME);
        this.userPath = path.join(workspace, HistoryManager.USER_REL_PATH);
        this.memoryPath = path.join(workspace, HistoryManager.MEMORY_REL_PATH);
        this.sessionId = this.#newSessionId();

        this.#initDB();
    }

    // ── 基础与辅助方法 ────────────────────────────────────

    #safeReadFile(filePath: string, defaultContent = ""): string {
        try {
            return readFileSync(filePath, "utf-8");
        } catch (err: any) {
            if (err.code !== 'ENOENT') {
                console.warn(`\n[HistoryManager] 警告: 读取文件失败 ${filePath} - ${err.message}`);
            }
            return defaultContent;
        }
    }

    #safeStatSize(filePath: string): number {
        try {
            const stat = statSync(filePath);
            return Math.round(stat.size / 1024);
        } catch (err: any) {
            if (err.code !== 'ENOENT') {
                console.warn(`\n[HistoryManager] 警告: 读取文件状态失败 ${filePath} - ${err.message}`);
            }
            return 0;
        }
    }

    #getConn(): DatabaseSync {
        if (!this.db) {
            this.db = new DatabaseSync(this.dbPath);
            this.db.exec("PRAGMA journal_mode=WAL");
        }
        return this.db;
    }

    #newSessionId(): string {
        return `session_${Date.now()}`;
    }

    #localDate(date = new Date()): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    #localTime24(date = new Date()): string {
        const hour = String(date.getHours()).padStart(2, "0");
        const minute = String(date.getMinutes()).padStart(2, "0");
        return `${hour}:${minute}`;
    }

    #ensureColumns(table: string, columns: Array<{ name: string; ddl: string }>): void {
        const conn = this.#getConn();
        const existing = new Set(
            (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
                .map((column) => column.name),
        );

        for (const column of columns) {
            if (!existing.has(column.name)) {
                conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
            }
        }
    }

    #initDB(): void {
        const conn = this.#getConn();

        conn.exec(`
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL DEFAULT '',
                timestamp REAL NOT NULL,
                date TEXT NOT NULL,
                time_24h TEXT NOT NULL,
                user_input TEXT NOT NULL DEFAULT '',
                tool_names TEXT NOT NULL DEFAULT '',
                tools_json TEXT NOT NULL DEFAULT '[]',
                agent_response TEXT NOT NULL DEFAULT ''
            )
        `);

        this.#ensureColumns("turns", [
            { name: "session_id", ddl: "session_id TEXT NOT NULL DEFAULT ''" },
            { name: "timestamp", ddl: "timestamp REAL NOT NULL DEFAULT 0" },
            { name: "date", ddl: "date TEXT NOT NULL DEFAULT ''" },
            { name: "time_24h", ddl: "time_24h TEXT NOT NULL DEFAULT ''" },
            { name: "user_input", ddl: "user_input TEXT NOT NULL DEFAULT ''" },
            { name: "tool_names", ddl: "tool_names TEXT NOT NULL DEFAULT ''" },
            { name: "tools_json", ddl: "tools_json TEXT NOT NULL DEFAULT '[]'" },
            { name: "agent_response", ddl: "agent_response TEXT NOT NULL DEFAULT ''" },
        ]);

        conn.exec(`
            CREATE TABLE IF NOT EXISTS daily_activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id INTEGER NOT NULL,
                session_id TEXT NOT NULL DEFAULT '',
                timestamp REAL NOT NULL,
                date TEXT NOT NULL,
                time_24h TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                details TEXT NOT NULL DEFAULT '',
                tool_names TEXT NOT NULL DEFAULT '',
                outcome TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE
            )
        `);

        this.#ensureColumns("daily_activities", [
            { name: "turn_id", ddl: "turn_id INTEGER NOT NULL DEFAULT 0" },
            { name: "session_id", ddl: "session_id TEXT NOT NULL DEFAULT ''" },
            { name: "timestamp", ddl: "timestamp REAL NOT NULL DEFAULT 0" },
            { name: "date", ddl: "date TEXT NOT NULL DEFAULT ''" },
            { name: "time_24h", ddl: "time_24h TEXT NOT NULL DEFAULT ''" },
            { name: "title", ddl: "title TEXT NOT NULL DEFAULT ''" },
            { name: "details", ddl: "details TEXT NOT NULL DEFAULT ''" },
            { name: "tool_names", ddl: "tool_names TEXT NOT NULL DEFAULT ''" },
            { name: "outcome", ddl: "outcome TEXT NOT NULL DEFAULT ''" },
        ]);

        conn.exec("CREATE INDEX IF NOT EXISTS idx_turns_date ON turns(date)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_daily_activities_date ON daily_activities(date)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_daily_activities_timestamp ON daily_activities(timestamp)");
    }

    startNewSession(): void {
        this.sessionId = this.#newSessionId();
    }

    #compactText(value: string, maxChars: number): string {
        const normalized = value.replace(/\s+/g, " ").trim();
        if (normalized.length <= maxChars) return normalized;
        return `${normalized.slice(0, maxChars - 1)}…`;
    }

    #toolNames(tools?: ToolCallRecord[]): string {
        if (!tools || tools.length === 0) return "";
        return [...new Set(tools.map((tool) => tool.name).filter(Boolean))].join(", ");
    }

    #serializeToolCalls(tools?: ToolCallRecord[]): string {
        if (!tools || tools.length === 0) return "[]";
        return JSON.stringify(
            tools.map((tool) => ({
                name: tool.name,
                args: tool.args,
            })),
        );
    }

    #activityTitle(userInput: string): string {
        return this.#compactText(userInput.split(/\r?\n/)[0] ?? userInput, 120);
    }

    #activityDetails(userInput: string, toolNames: string): string {
        const lines = [`用户请求: ${this.#compactText(userInput, 600)}`];
        if (toolNames) lines.push(`调用工具: ${toolNames}`);
        return lines.join("\n");
    }

    saveTurn(
        sessionId: string,
        userInput: string,
        agentResponse: string,
        tools?: ToolCallRecord[],
    ): void {
        const now = new Date();
        const date = this.#localDate(now);
        const time24 = this.#localTime24(now);
        const timestamp = now.getTime() / 1000;
        const resolvedSessionId = sessionId.trim() || this.sessionId;
        const toolNames = this.#toolNames(tools);
        const toolsJson = this.#serializeToolCalls(tools);

        const conn = this.#getConn();
        const turnResult = conn.prepare(
            [
                "INSERT INTO turns",
                "(session_id, timestamp, date, time_24h, user_input, tool_names, tools_json, agent_response)",
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ].join(" "),
        ).run(
            resolvedSessionId,
            timestamp,
            date,
            time24,
            userInput,
            toolNames,
            toolsJson,
            agentResponse,
        );

        const turnId = Number(turnResult.lastInsertRowid);
        conn.prepare(
            [
                "INSERT INTO daily_activities",
                "(turn_id, session_id, timestamp, date, time_24h, title, details, tool_names, outcome)",
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ].join(" "),
        ).run(
            turnId,
            resolvedSessionId,
            timestamp,
            date,
            time24,
            this.#activityTitle(userInput),
            this.#activityDetails(userInput, toolNames),
            toolNames,
            this.#compactText(agentResponse, 1200),
        );
    }

    #dateFromQuery(query: string): string | undefined {
        const text = query.trim().toLowerCase();
        if (!text) return undefined;

        const today = new Date();
        if (text === "today" || text.includes("今天")) return this.#localDate(today);
        if (text === "yesterday" || text.includes("昨天")) {
            const d = new Date(today);
            d.setDate(d.getDate() - 1);
            return this.#localDate(d);
        }
        if (text.includes("前天")) {
            const d = new Date(today);
            d.setDate(d.getDate() - 2);
            return this.#localDate(d);
        }

        const ymd = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(text);
        if (ymd) {
            const year = ymd[1]!;
            const month = ymd[2]!.padStart(2, "0");
            const day = ymd[3]!.padStart(2, "0");
            return `${year}-${month}-${day}`;
        }

        const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
        if (md) {
            const year = String(today.getFullYear());
            const month = md[1]!.padStart(2, "0");
            const day = md[2]!.padStart(2, "0");
            return `${year}-${month}-${day}`;
        }

        return undefined;
    }

    #formatTurnLine(row: TurnRow): string {
        const toolPart = row.tool_names ? ` 工具: ${row.tool_names}` : " 工具: 无";
        const answer = this.#compactText(row.agent_response, 260);
        return `[${row.date} ${row.time_24h}] ${this.#compactText(row.user_input, 180)}${toolPart}\n  Agent: ${answer}`;
    }

    search(query: string, limit = 5): string {
        const conn = this.#getConn();
        const terms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean);
        const searchTerms = terms.length > 0 ? terms : [query];
        const turnWhere = searchTerms.map(() => "(user_input LIKE ? OR agent_response LIKE ? OR tool_names LIKE ? OR tools_json LIKE ?)").join(" OR ");
        const turnParams = searchTerms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`]);
        const turnRows = conn.prepare(
            [
                "SELECT date, time_24h, session_id, user_input, tool_names, agent_response",
                "FROM turns",
                `WHERE ${turnWhere}`,
                "ORDER BY timestamp DESC LIMIT ?",
            ].join(" "),
        ).all(...turnParams, limit) as unknown as TurnRow[];

        if (turnRows.length === 0) {
            return `未找到与 '${query}' 相关的历史记录。`;
        }

        return [`搜索 '${query}'：`, "", "=== 原始轮次 ===", ...turnRows.map((row) => this.#formatTurnLine(row))].join("\n");
    }

    getRecent(limit = 10): string {
        const conn = this.#getConn();
        const rows = conn.prepare(
            [
                "SELECT date, time_24h, session_id, user_input, tool_names, agent_response",
                "FROM turns",
                "ORDER BY timestamp DESC LIMIT ?",
            ].join(" "),
        ).all(limit) as unknown as TurnRow[];

        if (rows.length === 0) return "暂无历史记录。";

        return ["=== 最近原始轮次 ===", ...[...rows].reverse().map((row) => this.#formatTurnLine(row))].join("\n");
    }

    getRecentHistory(limit = 10): string { return this.getRecent(limit); }

    getDayHistory(dateQuery: string, limit = 80): string {
        const date = this.#dateFromQuery(dateQuery) ?? dateQuery.trim();
        if (!date) return "day 查询需要提供日期，例如 2026-06-09、6月9日、今天或昨天。";

        const conn = this.#getConn();
        const rows = conn.prepare(
            [
                "SELECT date, time_24h, session_id, title, tool_names, outcome",
                "FROM daily_activities",
                "WHERE date = ?",
                "ORDER BY timestamp ASC LIMIT ?",
            ].join(" "),
        ).all(date, limit) as unknown as ActivityRow[];

        if (rows.length === 0) {
            return `未找到 ${date} 的活动记录。`;
        }

        const lines = [`${date} 的活动记录 (${rows.length} 条)：`];
        for (const row of rows) {
            lines.push(`[${row.time_24h}] ${row.title}`);
            lines.push(`  工具: ${row.tool_names || "无"}`);
            if (row.outcome) lines.push(`  结果: ${this.#compactText(row.outcome, 220)}`);
        }
        return lines.join("\n");
    }

    getStats() {
        const conn = this.#getConn();
        const turnCount = (conn.prepare("SELECT COUNT(*) as count FROM turns").get() as { count: number }).count;
        const activityCount = (conn.prepare("SELECT COUNT(*) as count FROM daily_activities").get() as { count: number }).count;
        const oldestRow = conn.prepare("SELECT MIN(timestamp) as d FROM turns").get() as { d: number | null };
        const newestRow = conn.prepare("SELECT MAX(timestamp) as d FROM turns").get() as { d: number | null };

        return {
            turnCount,
            activityCount,
            dbSizeKB: this.#safeStatSize(this.dbPath),
            oldestDate: oldestRow.d ? new Date(oldestRow.d * 1000).toLocaleString("zh-CN") : "-",
            newestDate: newestRow.d ? new Date(newestRow.d * 1000).toLocaleString("zh-CN") : "-",
        };
    }

    getUserMemoryStats() {
        const charCount = Buffer.byteLength(this.#safeReadFile(this.userPath), "utf-8");
        return {
            exists: charCount > 0,
            charCount,
            threshold: MEMORY_FILE_SIZE_THRESHOLD,
            percentUsed: Math.round((charCount / MEMORY_FILE_SIZE_THRESHOLD) * 100),
        };
    }

    getSystemMemoryStats() {
        const charCount = Buffer.byteLength(this.#safeReadFile(this.memoryPath, DEFAULT_SYSTEM_MEMORY_CONTENT), "utf-8");
        return {
            exists: charCount > 0,
            charCount,
            threshold: MEMORY_FILE_SIZE_THRESHOLD,
            percentUsed: Math.round((charCount / MEMORY_FILE_SIZE_THRESHOLD) * 100),
        };
    }

    #mergeUserFacts(facts: UserFact[]): number {
        const fallbackDate = new Date().toLocaleDateString("zh-CN");
        const existing = this.#sanitizeUserMemory(this.#parseUserMemory(this.#safeReadFile(this.userPath)));
        let keptCount = 0;

        for (const fact of facts) {
            const text = fact.fact.trim();
            if (!text || !this.#shouldKeepUserFact(text)) continue;

            const date = fact.last_confirmed?.trim() || fallbackDate;
            const section = this.#classifyUserFact(text);
            if (!section) continue;
            
            const normalized = this.#userFactKey(text);
            const line = `- [${date}] ${text}`;
            const current = existing[section];
            const duplicateIndex = current.findIndex(entry => this.#userFactKey(entry) === normalized);

            if (duplicateIndex >= 0) current[duplicateIndex] = line;
            else current.push(line);
            
            keptCount++;
        }

        mkdirSync(path.dirname(this.userPath), { recursive: true });
        writeFileSync(this.userPath, this.#formatUserMemory(existing), "utf-8");
        return keptCount;
    }

    #emptyUserMemory(): ParsedUserMemory {
        return { "Current Preferences": [], Environment: [], Projects: [], "Historical Notes": [] };
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
            if (trimmed.startsWith("- ")) parsed[current].push(trimmed);
            else if (!trimmed.startsWith("#") && !trimmed.startsWith(">")) parsed[current].push(`- ${trimmed}`);
        }
        return this.#dedupeUserMemory(parsed);
    }

    #formatUserMemory(memory: ParsedUserMemory): string {
        const lines = ["# User Memory", "", "> This file is maintained automatically. Keep durable user facts here."];
        for (const section of ["Current Preferences", "Environment"] as UserMemorySection[]) {
            lines.push("", `## ${section}`);
            lines.push(memory[section].length === 0 ? "- (none)" : memory[section].join("\n"));
        }
        return `${lines.join("\n")}\n`;
    }

    #dedupeUserMemory(memory: ParsedUserMemory): ParsedUserMemory {
        const deduped = this.#emptyUserMemory();
        for (const section of Object.keys(deduped) as UserMemorySection[]) {
            const byKey = new Map<string, string>();
            for (const entry of memory[section]) {
                if (entry !== "- (none)") byKey.set(this.#userFactKey(entry), entry);
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
                if (targetSection) sanitized[targetSection].push(entry.trim());
            }
        }
        return this.#dedupeUserMemory(sanitized);
    }

    #toUserMemorySection(value: string): UserMemorySection | undefined {
        const normalized = value.trim().toLowerCase();
        if (normalized === "current preferences") return "Current Preferences";
        if (normalized === "environment") return "Environment";
        return undefined;
    }

    #classifyUserFact(fact: string): UserMemorySection | undefined {
        if (HistoryManager.REGEX_ENV_STABLE.test(fact)) return "Environment";
        return "Current Preferences";
    }

    #shouldKeepUserFact(fact: string): boolean {
        const text = this.#extractUserFactText(fact);
        if (!text || HistoryManager.REGEX_SPECULATIVE.test(text) || HistoryManager.REGEX_TRANSIENT_USER.test(text) || HistoryManager.REGEX_PROJECT_SYSTEM.test(text)) {
            return false;
        }
        return HistoryManager.REGEX_USER_HABIT_VERB.test(text) || 
               (HistoryManager.REGEX_USER_PREF_TASTE.test(text) && HistoryManager.REGEX_USER_PREF_FOOD.test(text)) || 
               HistoryManager.REGEX_USER_PREF_ACTION.test(text) || 
               HistoryManager.REGEX_ENV_STABLE.test(text);
    }

    #extractUserFactText(value: string): string {
        return value.replace(/^-\s*/, "").replace(/^\[[^\]]+\]\s*/, "").trim();
    }

    #userFactKey(value: string): string {
        const text = this.#extractUserFactText(value).replace(/\*\*/g, "");
        const lower = text.toLowerCase();

        if (/(中文|chinese)/i.test(text) && /(语言|沟通)/i.test(text)) return "pref:language:zh";
        if (/(中文|chinese)/i.test(text) && /(注释|comment)/i.test(text)) return "pref:comment:zh";
        if (/codegraph/.test(lower)) return "pref:codegraph-first";
        if (/(默认下载目录|下载目录)/.test(text)) return "env:download-dir";

        const os = /(windows|linux|macos)/i.exec(text)?.[1]?.toLowerCase();
        if (os && /(操作系统|os|环境)/i.test(text)) return `env:os:${os}`;

        return text.replace(/[，。！？,.!?;；:："'`[\]()（）]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    #mergeSystemFacts(facts: SystemFact[]): number {
        const fallbackDate = new Date().toLocaleDateString("zh-CN");
        const { prefix, entries, suffix } = this.#parseSystemMemory(this.#safeReadFile(this.memoryPath, DEFAULT_SYSTEM_MEMORY_CONTENT));
        const current = this.#sanitizeSystemMemoryEntries(entries);
        let keptCount = 0;

        for (const fact of facts) {
            const text = fact.fact.trim();
            if (!text || !this.#shouldKeepSystemFact(text)) continue;

            const date = fact.last_confirmed?.trim() || fallbackDate;
            const kind = this.#classifySystemFact(text, fact.kind);
            const line = `- [${date}] [${this.#systemFactLabel(kind)}] ${text}`;
            const normalized = this.#systemFactKey(text);
            
            const duplicateIndex = current.findIndex(entry => this.#systemFactKey(entry) === normalized);
            if (duplicateIndex >= 0) current[duplicateIndex] = line;
            else current.push(line);
            keptCount++;
        }

        mkdirSync(path.dirname(this.memoryPath), { recursive: true });
        writeFileSync(this.memoryPath, this.#formatSystemMemory(prefix, current, suffix), "utf-8");
        return keptCount;
    }

    #parseSystemMemory(content: string) {
        const normalized = (content.trim() ? content : DEFAULT_SYSTEM_MEMORY_CONTENT).replace(/\r\n/g, "\n");
        const startIndex = normalized.indexOf(AUTO_SYSTEM_MEMORY_START);
        const endIndex = normalized.indexOf(AUTO_SYSTEM_MEMORY_END);

        if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
            return { prefix: normalized.trimEnd(), entries: [], suffix: "" };
        }

        return {
            prefix: normalized.slice(0, startIndex).trimEnd() || DEFAULT_SYSTEM_MEMORY_CONTENT.trimEnd(),
            entries: normalized.slice(startIndex + AUTO_SYSTEM_MEMORY_START.length, endIndex).trim().split("\n").map(l => l.trim()).filter(l => l.startsWith("- ")),
            suffix: normalized.slice(endIndex + AUTO_SYSTEM_MEMORY_END.length).trim()
        };
    }

    #formatSystemMemory(prefix: string, entries: string[], suffix = ""): string {
        const lines = [prefix.trimEnd(), "", AUTO_SYSTEM_MEMORY_START, AUTO_SYSTEM_MEMORY_HEADING, ""];
        lines.push(entries.length === 0 ? "- (none)" : entries.join("\n"));
        lines.push(AUTO_SYSTEM_MEMORY_END);
        if (suffix.trim()) lines.push("", suffix.trimEnd());
        return lines.join("\n") + "\n";
    }

    #sanitizeSystemMemoryEntries(entries: string[]): string[] {
        const byKey = new Map<string, string>();
        for (const entry of entries) {
            if (entry === "- (none)") continue;
            const text = this.#extractSystemFactText(entry);
            if (this.#shouldKeepSystemFact(text)) byKey.set(this.#systemFactKey(entry), entry.trim());
        }
        return [...byKey.values()];
    }

    #shouldKeepSystemFact(fact: string): boolean {
        const text = this.#extractSystemFactText(fact);
        if (!text || HistoryManager.REGEX_SPECULATIVE.test(text) || HistoryManager.REGEX_SYS_TRANSIENT.test(text) || HistoryManager.REGEX_PROJECT_SYSTEM.test(text)) {
            return false;
        }
        return (HistoryManager.REGEX_SYS_RULE_DIR.test(text) && HistoryManager.REGEX_SYS_RULE_CTX.test(text)) ||
               (HistoryManager.REGEX_SYS_METHOD_REP.test(text) && HistoryManager.REGEX_SYS_METHOD_CTX.test(text)) ||
               (HistoryManager.REGEX_SYS_MISTAKE_DIR.test(text) && HistoryManager.REGEX_SYS_MISTAKE_CTX.test(text));
    }

    #classifySystemFact(fact: string, suggestedKind?: string): SystemFactKind {
        const kind = suggestedKind?.trim().toLowerCase();
        if (kind === "user_method" || kind === "agent_rule" || kind === "agent_avoid") return kind as SystemFactKind;
        if (HistoryManager.REGEX_SYS_MISTAKE_DIR.test(fact)) return "agent_avoid";
        if (HistoryManager.REGEX_SYS_METHOD_REP.test(fact)) return "user_method";
        return "agent_rule";
    }

    #systemFactLabel(kind: SystemFactKind): string {
        return kind === "user_method" ? "用户方法" : kind === "agent_avoid" ? "避免错误" : "执行规则";
    }

    #extractSystemFactText(value: string): string {
        return value.replace(/^-\s*/, "").replace(/^\[[^\]]+\]\s*/, "").replace(/^\[[^\]]+\]\s*/, "").trim();
    }

    #systemFactKey(value: string): string {
        const text = this.#extractSystemFactText(value);
        if (/codegraph/i.test(text)) return "system:codegraph-first";
        if (/(taskkill|stop-process)/i.test(text)) return "system:close-app-taskkill";
        return text.replace(/[，。！？,.!?;；:："'`[\]()（）]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    #condenseUserMemory(): boolean { return this.#condensePlainMemoryFile(this.userPath, "USER.md"); }
    #condenseSystemMemory(): boolean { return this.#condensePlainMemoryFile(this.memoryPath, "MEMORY.md"); }

    #condensePlainMemoryFile(filePath: string, label: string): boolean {
        let content = this.#safeReadFile(filePath);
        if (!content) return false;

        const originalSize = Buffer.byteLength(content, "utf-8");
        if (originalSize <= MEMORY_FILE_SIZE_THRESHOLD) return false;

        const { result, strategy } = compressContent(content, "auto");
        if (result === content) return false;

        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, result, "utf-8");
        console.log(`  [memory] ${label} auto-compressed (${strategy})`);
        return true;
    }

    async checkAndCondense(): Promise<boolean> {
        let didCondense = false;
        if (this.#condenseUserMemory()) didCondense = true;
        if (this.#condenseSystemMemory()) didCondense = true;
        return didCondense;
    }
}
