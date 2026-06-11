// src/memory/history-manager.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync, readFileSync, writeFileSync, existsSync } from "fs";
import * as path from "path";
import "dotenv/config";
import { compressContent, MEMORY_FILE_SIZE_THRESHOLD } from "../tools/compress-tool.js";
import { resolveProjectRoot } from "../config/agent-paths.js";

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
    id: number;
    turn_id: number;
    timestamp: number;
    date: string;
    time_24h: string;
    session_id: string;
    ask: string;
    tool_name: string;
    tool_used: string;
    answer: string;
}

interface ActivityRow {
    id: number;
    turn_id: number;
    timestamp: number;
    date: string;
    time_24h: string;
    session_id: string;
    ask: string;
    tool_name: string;
    tool_used: string;
    answer: string;
}

interface TrialCandidateRow {
    id: number;
    session_id: string;
    turn_id: number;
    date: string;
    time_24h: string;
    ask: string;
    tool_name: string;
    tool_used: string;
    tool_kind_count: number;
    tool_call_count: number;
    switch_count: number;
    score: number;
    reason: string;
}

type SystemFactKind = "user_method" | "agent_rule" | "agent_avoid";

type UserMemorySection = "Current Preferences" | "Environment" | "Projects" | "Historical Notes";
type ParsedUserMemory = Record<UserMemorySection, string[]>;
type SystemMemorySection = "Agent Rules" | "Project Rules" | "Tooling" | "Historical Notes";
type ParsedSystemMemory = Record<SystemMemorySection, string[]>;

export class HistoryManager {
    static DB_FILENAME = "history.db";
    static TRIAL_CANDIDATES_FILENAME = "trial_candidates.json";
    static USER_REL_PATH = ".fyuobot/memories/USER.md";
    static MEMORY_REL_PATH = ".fyuobot/memories/MEMORY.md";

    private static readonly REGEX_SPECULATIVE = /(可能|推断|猜测|疑似|大概|也许|似乎|probably|maybe|seems)/i;
    private static readonly REGEX_PROJECT_SYSTEM = /(仓库|repo|repository|技能|skill|workflow|工作流|github|gitlab|模型|model|baseurl|api|提示词|prompt|记忆系统|代码库|博客|路由|架构|部署|ecs|redis|postgres|docker|mcp|fyuobot|setup-architecture|coding-workflow|deepseek)/i;
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
    private trialCandidatesPath: string;
    private userPath: string;
    private memoryPath: string;
    private sessionId: string;
    private db: DatabaseSync | null = null; 

    static instance(workspace?: string): HistoryManager {
        if (!HistoryManager._instance) {
            HistoryManager._instance = new HistoryManager(
                workspace ?? resolveProjectRoot(),
            );
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
        this.trialCandidatesPath = path.join(dbDir, HistoryManager.TRIAL_CANDIDATES_FILENAME);
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

    #hasIndex(table: string, indexName: string): boolean {
        const conn = this.#getConn();
        const rows = conn.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
        return rows.some((row) => row.name === indexName);
    }

    #backfillScopedTurnIds(): void {
        const conn = this.#getConn();
        conn.exec(`
            WITH ranked AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY session_id
                        ORDER BY timestamp ASC, id ASC
                    ) AS scoped_turn_id
                FROM turns
            )
            UPDATE turns
            SET turn_id = (
                SELECT ranked.scoped_turn_id
                FROM ranked
                WHERE ranked.id = turns.id
            )
            WHERE id IN (SELECT id FROM ranked)
        `);
    }

    #columnNames(table: string): string[] {
        const conn = this.#getConn();
        return (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
            .map((column) => column.name);
    }

    #rebuildTurnsTable(): void {
        const conn = this.#getConn();
        const columns = new Set(this.#columnNames("turns"));
        const expected = [
            "id",
            "session_id",
            "turn_id",
            "date",
            "time_24h",
            "timestamp",
            "ask",
            "tool_name",
            "tool_used",
            "answer",
        ];
        const needsRebuild =
            expected.some((name) => !columns.has(name)) ||
            columns.has("user_input") ||
            columns.has("tool_names") ||
            columns.has("tools_json") ||
            columns.has("agent_response");

        if (!needsRebuild) return;

        conn.exec(`
            CREATE TABLE turns_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL DEFAULT '',
                turn_id INTEGER NOT NULL DEFAULT 0,
                date TEXT NOT NULL,
                time_24h TEXT NOT NULL,
                timestamp REAL NOT NULL,
                ask TEXT NOT NULL DEFAULT '',
                tool_name TEXT NOT NULL DEFAULT '',
                tool_used TEXT NOT NULL DEFAULT '',
                answer TEXT NOT NULL DEFAULT ''
            )
        `);

        const askExpr = columns.has("ask") ? "ask" : columns.has("user_input") ? "user_input" : "''";
        const toolNameExpr = columns.has("tool_name") ? "tool_name" : columns.has("tool_names") ? "tool_names" : "''";
        const toolUsedExpr = columns.has("tool_used")
            ? "tool_used"
            : columns.has("tools_json")
              ? "tools_json"
              : "''";
        const answerExpr = columns.has("answer") ? "answer" : columns.has("agent_response") ? "agent_response" : "''";
        const turnIdExpr = columns.has("turn_id") ? "turn_id" : "0";

        conn.exec(`
            INSERT INTO turns_new (id, session_id, turn_id, date, time_24h, timestamp, ask, tool_name, tool_used, answer)
            SELECT
                id,
                session_id,
                ${turnIdExpr},
                date,
                time_24h,
                timestamp,
                ${askExpr},
                ${toolNameExpr},
                ${toolUsedExpr},
                ${answerExpr}
            FROM turns
        `);

        conn.exec("DROP TABLE turns");
        conn.exec("ALTER TABLE turns_new RENAME TO turns");
    }

    #rebuildDailyActivitiesTable(): void {
        const conn = this.#getConn();
        const columns = new Set(this.#columnNames("daily_activities"));
        const expected = [
            "id",
            "turn_id",
            "session_id",
            "date",
            "time_24h",
            "timestamp",
            "ask",
            "tool_name",
            "tool_used",
            "answer",
        ];
        const needsRebuild =
            expected.some((name) => !columns.has(name)) ||
            columns.has("title") ||
            columns.has("details") ||
            columns.has("tool_names") ||
            columns.has("outcome");

        if (!needsRebuild) return;

        conn.exec(`
            CREATE TABLE daily_activities_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id INTEGER NOT NULL,
                session_id TEXT NOT NULL DEFAULT '',
                timestamp REAL NOT NULL,
                date TEXT NOT NULL,
                time_24h TEXT NOT NULL,
                ask TEXT NOT NULL DEFAULT '',
                tool_name TEXT NOT NULL DEFAULT '',
                tool_used TEXT NOT NULL DEFAULT '',
                answer TEXT NOT NULL DEFAULT ''
            )
        `);

        const askExpr = columns.has("ask") ? "ask" : columns.has("title") ? "title" : "''";
        const toolNameExpr = columns.has("tool_name") ? "tool_name" : columns.has("tool_names") ? "tool_names" : "''";
        const toolUsedExpr = columns.has("tool_used") ? "tool_used" : "''";
        const answerExpr = columns.has("answer") ? "answer" : columns.has("outcome") ? "outcome" : "''";

        conn.exec(`
            INSERT INTO daily_activities_new (id, turn_id, session_id, timestamp, date, time_24h, ask, tool_name, tool_used, answer)
            SELECT
                id,
                turn_id,
                session_id,
                timestamp,
                date,
                time_24h,
                ${askExpr},
                ${toolNameExpr},
                ${toolUsedExpr},
                ${answerExpr}
            FROM daily_activities
        `);

        conn.exec("DROP TABLE daily_activities");
        conn.exec("ALTER TABLE daily_activities_new RENAME TO daily_activities");
    }

    #renameColumnIfExists(table: string, from: string, to: string): void {
        const conn = this.#getConn();
        const columns = new Set(
            (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
                .map((column) => column.name),
        );
        if (columns.has(from) && !columns.has(to)) {
            conn.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
        }
    }

    #initDB(): void {
        const conn = this.#getConn();

        conn.exec(`
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id INTEGER NOT NULL DEFAULT 0,
                session_id TEXT NOT NULL DEFAULT '',
                timestamp REAL NOT NULL,
                date TEXT NOT NULL,
                time_24h TEXT NOT NULL,
                ask TEXT NOT NULL DEFAULT '',
                tool_name TEXT NOT NULL DEFAULT '',
                tool_used TEXT NOT NULL DEFAULT '',
                answer TEXT NOT NULL DEFAULT ''
            )
        `);

        this.#renameColumnIfExists("turns", "user_input", "ask");
        this.#renameColumnIfExists("turns", "tool_names", "tool_name");
        this.#renameColumnIfExists("turns", "agent_response", "answer");
        this.#renameColumnIfExists("turns", "tools_json", "tool_used");
        this.#rebuildTurnsTable();

        this.#ensureColumns("turns", [
            { name: "turn_id", ddl: "turn_id INTEGER NOT NULL DEFAULT 0" },
            { name: "session_id", ddl: "session_id TEXT NOT NULL DEFAULT ''" },
            { name: "timestamp", ddl: "timestamp REAL NOT NULL DEFAULT 0" },
            { name: "date", ddl: "date TEXT NOT NULL DEFAULT ''" },
            { name: "time_24h", ddl: "time_24h TEXT NOT NULL DEFAULT ''" },
            { name: "ask", ddl: "ask TEXT NOT NULL DEFAULT ''" },
            { name: "tool_name", ddl: "tool_name TEXT NOT NULL DEFAULT ''" },
            { name: "tool_used", ddl: "tool_used TEXT NOT NULL DEFAULT ''" },
            { name: "answer", ddl: "answer TEXT NOT NULL DEFAULT ''" },
        ]);

        conn.exec(`
            CREATE TABLE IF NOT EXISTS daily_activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id INTEGER NOT NULL,
                session_id TEXT NOT NULL DEFAULT '',
                timestamp REAL NOT NULL,
                date TEXT NOT NULL,
                time_24h TEXT NOT NULL,
                ask TEXT NOT NULL DEFAULT '',
                tool_name TEXT NOT NULL DEFAULT '',
                tool_used TEXT NOT NULL DEFAULT '',
                answer TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE
            )
        `);

        this.#renameColumnIfExists("daily_activities", "title", "ask");
        this.#renameColumnIfExists("daily_activities", "tool_names", "tool_name");
        this.#renameColumnIfExists("daily_activities", "outcome", "answer");
        this.#rebuildDailyActivitiesTable();

        this.#ensureColumns("daily_activities", [
            { name: "turn_id", ddl: "turn_id INTEGER NOT NULL DEFAULT 0" },
            { name: "session_id", ddl: "session_id TEXT NOT NULL DEFAULT ''" },
            { name: "timestamp", ddl: "timestamp REAL NOT NULL DEFAULT 0" },
            { name: "date", ddl: "date TEXT NOT NULL DEFAULT ''" },
            { name: "time_24h", ddl: "time_24h TEXT NOT NULL DEFAULT ''" },
            { name: "ask", ddl: "ask TEXT NOT NULL DEFAULT ''" },
            { name: "tool_name", ddl: "tool_name TEXT NOT NULL DEFAULT ''" },
            { name: "tool_used", ddl: "tool_used TEXT NOT NULL DEFAULT ''" },
            { name: "answer", ddl: "answer TEXT NOT NULL DEFAULT ''" },
        ]);

        this.#backfillScopedTurnIds();

        conn.exec("CREATE INDEX IF NOT EXISTS idx_turns_date ON turns(date)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id)");
        if (!this.#hasIndex("turns", "idx_turns_session_turn_id")) {
            conn.exec("CREATE UNIQUE INDEX idx_turns_session_turn_id ON turns(session_id, turn_id)");
        }
        conn.exec("CREATE INDEX IF NOT EXISTS idx_daily_activities_date ON daily_activities(date)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_daily_activities_timestamp ON daily_activities(timestamp)");

        conn.exec("DROP TABLE IF EXISTS trial_candidates");
        this.#normalizeStoredToolUsed();
    }

    startNewSession(): void {
        this.sessionId = this.#newSessionId();
    }

    #compactText(value: string, maxChars: number): string {
        const normalized = value.replace(/\s+/g, " ").trim();
        if (normalized.length <= maxChars) return normalized;
        return `${normalized.slice(0, maxChars - 1)}…`;
    }

    #escapeToolSegmentText(value: string): string {
        return JSON.stringify(this.#compactText(value, 300));
    }

    #normalizeJsonLikeText(value: string): string {
        const trimmed = value.trim();
        if (!trimmed) return "{}";
        try {
            return JSON.stringify(JSON.parse(trimmed));
        } catch {
            return JSON.stringify(trimmed);
        }
    }

    #toolNames(tools?: ToolCallRecord[]): string {
        if (!tools || tools.length === 0) return "";
        return [...new Set(tools.map((tool) => tool.name).filter(Boolean))].join(", ");
    }

    #formatToolUsed(tools?: ToolCallRecord[]): string {
        if (!tools || tools.length === 0) return "";
        return tools
            .map((tool) => {
                const args = JSON.stringify(tool.args ?? {});
                const result = this.#escapeToolSegmentText(tool.result ?? "");
                return `${tool.name}{{${args},${result}}}`;
            })
            .join(", ");
    }

    #nextTurnId(sessionId: string): number {
        const conn = this.#getConn();
        const row = conn.prepare("SELECT COALESCE(MAX(turn_id), 0) AS max_turn_id FROM turns WHERE session_id = ?").get(sessionId) as {
            max_turn_id: number;
        };
        return row.max_turn_id + 1;
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
        const turnId = this.#nextTurnId(resolvedSessionId);
        const toolName = this.#toolNames(tools);
        const toolUsed = this.#formatToolUsed(tools);

        const conn = this.#getConn();
        conn.prepare(
            [
                "INSERT INTO turns",
                "(turn_id, session_id, timestamp, date, time_24h, ask, tool_name, tool_used, answer)",
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ].join(" "),
        ).run(
            turnId,
            resolvedSessionId,
            timestamp,
            date,
            time24,
            userInput,
            toolName,
            toolUsed,
            agentResponse,
        );

        conn.prepare(
            [
                "INSERT INTO daily_activities",
                "(turn_id, session_id, timestamp, date, time_24h, ask, tool_name, tool_used, answer)",
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ].join(" "),
        ).run(
            turnId,
            resolvedSessionId,
            timestamp,
            date,
            time24,
            userInput,
            toolName,
            toolUsed,
            agentResponse,
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
        const toolPart = row.tool_name ? ` 工具: ${row.tool_name}` : " 工具: 无";
        const answer = this.#compactText(row.answer, 260);
        const used = row.tool_used ? `\n  Tool used:\n${row.tool_used}` : "";
        return `[${row.date} ${row.time_24h}] (${row.session_id}#${row.turn_id}) ${this.#compactText(row.ask, 180)}${toolPart}\n  Agent: ${answer}${used}`;
    }

    #parseToolSequence(toolUsed: string): string[] {
        if (!toolUsed.trim()) return [];

        const modernMatches = [...toolUsed.matchAll(/(^|,\s*)([A-Za-z0-9_.-]+)\{\{/g)];
        if (modernMatches.length > 0) {
            return modernMatches
                .map((match) => match[2] ?? "")
                .filter(Boolean);
        }

        const legacyMatches = [...toolUsed.matchAll(/^#\d+\s+([^\s]+)$/gm)];
        return legacyMatches.map((match) => match[1] ?? "").filter(Boolean);
    }

    #convertLegacyToolUsed(toolUsed: string): string {
        const trimmed = toolUsed.trim();
        if (!trimmed) return "";
        if (/(^|,\s*)[A-Za-z0-9_.-]+\{\{/.test(trimmed)) return trimmed;

        const blocks = trimmed
            .split(/\n\s*\n(?=#\d+\s+)/)
            .map((block) => block.trim())
            .filter(Boolean);

        const converted = blocks
            .map((block) => {
                const lines = block.split("\n");
                const header = lines[0]?.match(/^#\d+\s+([^\s]+)$/);
                const toolName = header?.[1]?.trim();
                if (!toolName) return "";

                const inputLine = lines.find((line) => line.startsWith("input:"));
                const outputLine = lines.find((line) => line.startsWith("output:"));
                const rawInput = inputLine ? inputLine.slice("input:".length).trim() : "{}";
                const rawOutput = outputLine ? outputLine.slice("output:".length).trim() : "";

                return `${toolName}{{${this.#normalizeJsonLikeText(rawInput)},${this.#escapeToolSegmentText(rawOutput)}}}`;
            })
            .filter(Boolean);

        return converted.join(", ");
    }

    #normalizeStoredToolUsed(): void {
        const conn = this.#getConn();

        for (const table of ["turns", "daily_activities"]) {
            const rows = conn.prepare(
                `SELECT id, tool_used FROM ${table} WHERE tool_used LIKE '#%'`,
            ).all() as Array<{ id: number; tool_used: string }>;

            if (rows.length === 0) continue;

            const updateStmt = conn.prepare(`UPDATE ${table} SET tool_used = ? WHERE id = ?`);
            for (const row of rows) {
                const normalized = this.#convertLegacyToolUsed(row.tool_used);
                if (!normalized || normalized === row.tool_used) continue;
                updateStmt.run(normalized, row.id);
            }
        }
    }

    #analyzeTurnComplexity(row: TurnRow) {
        const toolKinds = row.tool_name
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean);
        const toolSequence = this.#parseToolSequence(row.tool_used);

        let switchCount = 0;
        for (let i = 1; i < toolSequence.length; i++) {
            if (toolSequence[i] !== toolSequence[i - 1]) switchCount++;
        }

        const toolKindCount = toolKinds.length;
        const toolCallCount = toolSequence.length;
        const score = toolKindCount * 2 + toolCallCount + switchCount * 2;
        const reasons = [
            `tool kinds=${toolKindCount}`,
            `tool calls=${toolCallCount}`,
            `switches=${switchCount}`,
        ];

        return {
            toolKindCount,
            toolCallCount,
            switchCount,
            score,
            reason: reasons.join(", "),
            isCandidate:
                score >= 8 || toolKindCount >= 3 || toolCallCount >= 4,
        };
    }

    #loadTrialCandidates(): TrialCandidateRow[] {
        if (!existsSync(this.trialCandidatesPath)) return [];
        try {
            const raw = readFileSync(this.trialCandidatesPath, "utf-8").trim();
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed as TrialCandidateRow[] : [];
        } catch {
            return [];
        }
    }

    #saveTrialCandidates(candidates: TrialCandidateRow[]): void {
        writeFileSync(this.trialCandidatesPath, JSON.stringify(candidates, null, 2) + "\n", "utf-8");
    }

    getHighTrialCandidates(limit = 20): string {
        const conn = this.#getConn();
        const rows = conn.prepare(
            [
                "SELECT id, turn_id, timestamp, date, time_24h, session_id, ask, tool_name, tool_used, answer",
                "FROM turns",
                "ORDER BY timestamp DESC LIMIT ?",
            ].join(" "),
        ).all(Math.max(limit * 5, 50)) as unknown as TurnRow[];

        const candidates: TrialCandidateRow[] = [];
        for (const row of rows) {
            const analysis = this.#analyzeTurnComplexity(row);
            if (!analysis.isCandidate) continue;

            candidates.push({
                id: row.id,
                session_id: row.session_id,
                turn_id: row.turn_id,
                date: row.date,
                time_24h: row.time_24h,
                ask: row.ask,
                tool_name: row.tool_name,
                tool_used: row.tool_used,
                tool_kind_count: analysis.toolKindCount,
                tool_call_count: analysis.toolCallCount,
                switch_count: analysis.switchCount,
                score: analysis.score,
                reason: analysis.reason,
            });
        }

        candidates.sort((a, b) => b.score - a.score || b.turn_id - a.turn_id);
        const selected = candidates.slice(0, limit);
        this.#saveTrialCandidates(selected);

        if (selected.length === 0) {
            return "未发现高试错轮次候选。";
        }

        const lines = [`发现 ${selected.length} 条高试错轮次候选：`];
        for (const row of selected) {
            lines.push(
                `- (${row.session_id}#${row.turn_id}) score=${row.score}`,
            );
            lines.push(`  history id: ${row.id}`);
            lines.push(`  原因: ${row.reason}`);
            lines.push(`  用户请求: ${this.#compactText(row.ask, 140)}`);
            lines.push(`  工具种类: ${row.tool_name || "无"}`);
        }
        return lines.join("\n");
    }

    search(query: string, limit = 5): string {
        const conn = this.#getConn();
        const terms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean);
        const searchTerms = terms.length > 0 ? terms : [query];
        const turnWhere = searchTerms.map(() => "(ask LIKE ? OR answer LIKE ? OR tool_name LIKE ? OR tool_used LIKE ?)").join(" OR ");
        const turnParams = searchTerms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`]);
        const turnRows = conn.prepare(
            [
                "SELECT id, turn_id, timestamp, date, time_24h, session_id, ask, tool_name, tool_used, answer",
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
                "SELECT id, turn_id, timestamp, date, time_24h, session_id, ask, tool_name, tool_used, answer",
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
                "SELECT id, turn_id, timestamp, date, time_24h, session_id, ask, tool_name, tool_used, answer",
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
            lines.push(`[${row.time_24h}] (${row.session_id}#${row.turn_id}) ${row.ask}`);
            lines.push(`  工具: ${row.tool_name || "无"}`);
            if (row.tool_used) lines.push(`  过程: ${this.#compactText(row.tool_used, 260)}`);
            if (row.answer) lines.push(`  结果: ${this.#compactText(row.answer, 220)}`);
        }
        return lines.join("\n");
    }

    getStats() {
        const conn = this.#getConn();
        const turnCount = (conn.prepare("SELECT COUNT(*) as count FROM turns").get() as { count: number }).count;
        const activityCount = (conn.prepare("SELECT COUNT(*) as count FROM daily_activities").get() as { count: number }).count;
        const candidateCount = this.#loadTrialCandidates().length;
        const oldestRow = conn.prepare("SELECT MIN(timestamp) as d FROM turns").get() as { d: number | null };
        const newestRow = conn.prepare("SELECT MAX(timestamp) as d FROM turns").get() as { d: number | null };

        return {
            turnCount,
            activityCount,
            candidateCount,
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
        const charCount = Buffer.byteLength(this.#safeReadFile(this.memoryPath), "utf-8");
        return {
            exists: charCount > 0,
            charCount,
            threshold: MEMORY_FILE_SIZE_THRESHOLD,
            percentUsed: Math.round((charCount / MEMORY_FILE_SIZE_THRESHOLD) * 100),
        };
    }

    normalizeMemoryDocument(file: "user" | "memory", content: string): string {
        if (file === "user") {
            return this.#formatUserMemory(this.#sanitizeUserMemory(this.#parseUserMemory(content)));
        }
        return this.#formatSystemMemory(this.#sanitizeSystemMemory(this.#parseSystemMemory(content)));
    }

    #mergeUserFacts(facts: UserFact[]): number {
        const fallbackDate = new Date().toLocaleDateString("zh-CN");
        const existing = this.#parseUserMemory(this.#safeReadFile(this.userPath));
        let keptCount = 0;

        for (const fact of facts) {
            const text = fact.fact.trim();
            if (!text) continue;

            const date = fact.last_confirmed?.trim() || fallbackDate;
            const section = this.#classifyUserFact(text) ?? "Current Preferences";
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

    #emptySystemMemory(): ParsedSystemMemory {
        return { "Agent Rules": [], "Project Rules": [], Tooling: [], "Historical Notes": [] };
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
        for (const section of ["Current Preferences", "Environment", "Projects", "Historical Notes"] as UserMemorySection[]) {
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
                sanitized[section].push(entry.trim());
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

    #toSystemMemorySection(value: string): SystemMemorySection | undefined {
        const normalized = value.trim().toLowerCase();
        if (normalized === "agent rules") return "Agent Rules";
        if (normalized === "project rules") return "Project Rules";
        if (normalized === "tooling") return "Tooling";
        if (normalized === "historical notes") return "Historical Notes";
        return undefined;
    }

    #classifyUserFact(fact: string): UserMemorySection | undefined {
        const sectionMatch = /^\[(current preferences|environment|projects|historical notes)\]\s*/i.exec(fact);
        if (sectionMatch) {
            return this.#toUserMemorySection(sectionMatch[1] ?? "");
        }
        return "Current Preferences";
    }

    #extractUserFactText(value: string): string {
        return value
            .replace(/^-\s*/, "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .trim();
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

    #normalizeFactLine(date: string, sectionTag: string | undefined, text: string): string {
        const sectionPart = sectionTag ? `[${sectionTag}] ` : "";
        return `- [${date}] ${sectionPart}${text.trim()}`;
    }

    #mergeSystemFacts(facts: SystemFact[]): number {
        const fallbackDate = new Date().toLocaleDateString("zh-CN");
        const current = this.#sanitizeSystemMemory(this.#parseSystemMemory(this.#safeReadFile(this.memoryPath)));
        let keptCount = 0;

        for (const fact of facts) {
            const text = fact.fact.trim();
            if (!text || !this.#shouldKeepSystemFact(text)) continue;

            const date = fact.last_confirmed?.trim() || fallbackDate;
            const kind = this.#classifySystemFact(text, fact.kind);
            const section = this.#classifySystemMemorySection(text, kind);
            const line = this.#normalizeFactLine(date, section, text);
            const normalized = this.#systemFactKey(text);

            const target = current[section];
            const duplicateIndex = target.findIndex(entry => this.#systemFactKey(entry) === normalized);
            if (duplicateIndex >= 0) target[duplicateIndex] = line;
            else target.push(line);
            keptCount++;
        }

        mkdirSync(path.dirname(this.memoryPath), { recursive: true });
        writeFileSync(this.memoryPath, this.#formatSystemMemory(current), "utf-8");
        return keptCount;
    }

    #parseSystemMemory(content: string): ParsedSystemMemory {
        const parsed = this.#emptySystemMemory();
        let current: SystemMemorySection = "Agent Rules";

        for (const line of content.split(/\r?\n/)) {
            const heading = /^##\s+(.+?)\s*$/.exec(line);
            if (heading) {
                const section = this.#toSystemMemorySection(heading[1] ?? "");
                if (section) current = section;
                continue;
            }

            const trimmed = line.trim();
            if (!trimmed || trimmed === "# Memory") continue;
            if (trimmed.startsWith("- ")) parsed[current].push(trimmed);
            else if (!trimmed.startsWith("#") && !trimmed.startsWith(">")) parsed[current].push(`- ${trimmed}`);
        }
        return this.#dedupeSystemMemory(parsed);
    }

    #formatSystemMemory(memory: ParsedSystemMemory): string {
        const lines = ["# Memory", "", "> This file is maintained automatically. Keep durable system, project, and tooling rules here."];
        for (const section of ["Agent Rules", "Project Rules", "Tooling", "Historical Notes"] as SystemMemorySection[]) {
            lines.push("", `## ${section}`);
            lines.push(memory[section].length === 0 ? "- (none)" : memory[section].join("\n"));
        }
        return `${lines.join("\n")}\n`;
    }

    #dedupeSystemMemory(memory: ParsedSystemMemory): ParsedSystemMemory {
        const deduped = this.#emptySystemMemory();
        for (const section of Object.keys(deduped) as SystemMemorySection[]) {
            const byKey = new Map<string, string>();
            for (const entry of memory[section]) {
                if (entry !== "- (none)") byKey.set(this.#systemFactKey(entry), entry);
            }
            deduped[section] = [...byKey.values()];
        }
        return deduped;
    }

    #sanitizeSystemMemory(memory: ParsedSystemMemory): ParsedSystemMemory {
        const sanitized = this.#emptySystemMemory();
        for (const section of Object.keys(memory) as SystemMemorySection[]) {
            for (const entry of memory[section]) {
                if (entry === "- (none)") continue;
                sanitized[section].push(entry.trim());
            }
        }
        return this.#dedupeSystemMemory(sanitized);
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

    #classifySystemMemorySection(fact: string, kind: SystemFactKind): SystemMemorySection {
        const sectionMatch = /^\[(agent rules|project rules|tooling|historical notes)\]\s*/i.exec(fact);
        if (sectionMatch) {
            return this.#toSystemMemorySection(sectionMatch[1] ?? "") ?? "Agent Rules";
        }
        if (kind === "user_method") return "Tooling";
        if (/工具|tool|codegraph|taskkill|stop-process|powershell|rg|grep|sqlite/i.test(fact)) return "Tooling";
        if (/项目|project|代码库|repo|架构|workflow|工作流/i.test(fact)) return "Project Rules";
        if (kind === "agent_avoid") return "Historical Notes";
        return "Agent Rules";
    }

    #extractSystemFactText(value: string): string {
        return value
            .replace(/^-\s*/, "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .trim();
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
