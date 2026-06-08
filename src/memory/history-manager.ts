// src/memory/history-manager.ts
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs/promises";
import { mkdirSync, statSync, readFileSync, openSync, writeSync, closeSync, appendFileSync, writeFileSync } from "fs";
import * as path from "path";
import "dotenv/config";
import OpenAI from "openai";
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

interface SystemFact {
    last_confirmed: string;
    kind?: string;
    fact: string;
}

type SystemFactKind = "user_method" | "agent_rule" | "agent_avoid";

type UserMemorySection = "Current Preferences" | "Environment" | "Projects" | "Historical Notes";

type ParsedUserMemory = Record<UserMemorySection, string[]>;

const llmClient = new OpenAI({
    apiKey: process.env.THIRD_PARTY_API_KEY,
    baseURL: process.env.THIRD_PARTY_BASE_URL,
});
const targetModel = process.env.THIRD_PARTY_MODEL || "gpt-3.5-turbo";
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
    static HISTORY_REL_PATH = ".fyuobot/memories/HISTORY.md";
    static USER_REL_PATH = ".fyuobot/memories/USER.md";
    static MEMORY_REL_PATH = ".fyuobot/memories/MEMORY.md";
    static MAX_BUFFER_CHARS = 15_000; 
    static KEEP_RECENT_CHARS = 3_000; 
    static MAX_CONDENSE_PAYLOAD = 12_000;

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
    private historyPath: string;
    private userPath: string;
    private memoryPath: string;
    private sessionStart: string;
    private condensing = false; 
    private lastCondenseRequestAt = 0;
    private sessionHeaderWritten = false; 
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
        this.historyPath = path.join(workspace, HistoryManager.HISTORY_REL_PATH);
        this.userPath = path.join(workspace, HistoryManager.USER_REL_PATH);
        this.memoryPath = path.join(workspace, HistoryManager.MEMORY_REL_PATH);

        this.sessionStart = new Date().toLocaleString("zh-CN");

        this.#initDB();
        this.checkAndCondense();
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

    #initDB(): void {
        const conn = this.#getConn();
        const cursor = conn.prepare("PRAGMA table_info(conversations)");
        const columns = new Set<string>();
        for (const row of cursor.all() as Array<{ name: string }>) {
            columns.add(row.name);
        }

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

        for (const idx of ["session_id", "timestamp", "topic"]) {
            conn.exec(`CREATE INDEX IF NOT EXISTS idx_conv_${idx} ON conversations(${idx})`);
        }
    }

    #insertCondensed(entries: Array<{ session?: string; time_span?: string; topic: string; summary: string }>): void {
        const conn = this.#getConn();
        const insert = conn.prepare(
            "INSERT INTO conversations (session_id, timestamp, topic, summary) VALUES (?, ?, ?, ?)",
        );
        
        for (const entry of entries) {
            let tsSeconds = Date.now() / 1000;
            
            if (entry.time_span) {
                const parts = entry.time_span.split('-');
                const lastDateStr = parts[parts.length - 1];
                if (lastDateStr) {
                    const parsedTs = Date.parse(lastDateStr.trim());
                    if (!isNaN(parsedTs)) {
                        tsSeconds = parsedTs / 1000;
                    }
                }
            }

            const finalSummary = entry.time_span 
                ? `[${entry.time_span}] ${entry.summary}` 
                : entry.summary;

            insert.run(entry.session ?? "", tsSeconds, entry.topic ?? "", finalSummary);
        }
    }

    #ensureSessionHeader(): void {
        if (this.sessionHeaderWritten) return;
        const existing = this.#readHistory();
        const count = (existing.match(/\n## 会话 /g)?.length ?? 0) + 1;
        const header = `\n## 会话 #${count} — ${this.sessionStart}\n\n`;
        this.#appendRaw(header);
        this.sessionHeaderWritten = true;
    }

    startNewSession(): void {
        this.sessionStart = new Date().toLocaleString("zh-CN");
        this.sessionHeaderWritten = false;
    }

    #readHistory(): string {
        return this.#safeReadFile(this.historyPath);
    }

    #appendRaw(text: string): void {
        const dir = path.dirname(this.historyPath);
        mkdirSync(dir, { recursive: true });
        try {
            const fd = openSync(this.historyPath, "a");
            writeSync(fd, text);
            closeSync(fd);
        } catch {
            appendFileSync(this.historyPath, text, "utf-8");
        }
    }

    #bufferSize(): number {
        return Buffer.byteLength(this.#readHistory(), "utf-8");
    }

    saveTurn(
        _sessionId: string,
        userInput: string,
        agentResponse: string,
        tools?: ToolCallRecord[],
    ): void {
        this.#ensureSessionHeader();

        const ts = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        const parts: string[] = [`[${ts}]`, `User: ${userInput}`];

        if (tools && tools.length > 0) {
            for (const tc of tools) {
                const argsSummary = JSON.stringify(tc.args);
                parts.push(`Tool: ${tc.name}(${argsSummary})`);
            }
        }

        parts.push(`Agent: ${agentResponse}`, "");
        const entry = parts.join("\n") + "\n";
        this.#appendRaw(entry);

        if (this.#bufferSize() > HistoryManager.MAX_BUFFER_CHARS) {
            this.#safeCondense();
        }
    }

    #safeCondense(): void {
        const now = Date.now();
        if (now - this.lastCondenseRequestAt < 1500) return;
        this.lastCondenseRequestAt = now;

        if (this.condensing) return;
        this.condensing = true;
        try {
            this.#condenseBuffer();
        } finally {
            this.condensing = false;
        }
    }

    static BATCH_CONDENSE_PROMPT = [
        "你是一个高级的对话历史归档与记忆提取引擎。以下是跨多个会话的完整对话记录。",
        "请仔细阅读并同时完成两个任务：",
        "",
        "【任务一：浓缩历史 (conversations)】",
        "1. 按话题分类，将相关的多轮对话归为一组，忽略纯寒暄。",
        "2. 每组用 1-3 句中文浓缩核心信息，分配 2-5 字的标签(topic)。",
        "3. 如果该话题跨越了多个时间点，请提取它的时间跨度；如果是单次对话，只需记录单个时间。",
        "",
        "【任务二：提取长期记忆 (user_facts)】",
        "1. 只提取对未来多个会话仍然成立、值得长期记住的用户事实：如沟通语言、稳定开发习惯、操作系统、用户明确表达且长期成立的偏好等。",
        "2. 严禁写入：临时任务、一次性调试过程、正在进行的实现细节、推测性事实。",
        "3. 将保留的信息提取为简洁陈述句。如发生变更，只保留最新确认的。",
        "4. 如果没有新的稳定用户事实，返回空数组 []。",
        "",
        "【任务三：提取操作经验 (system_facts)】",
        "1. 只提取跨多个会话重复出现、或被用户明确纠正过的方法。",
        "2. kind 仅限：user_method, agent_rule, agent_avoid。",
        "3. 严禁写入一次性任务内容或纯项目背景介绍。",
        "4. 如果没有新的操作经验，返回空数组 []。",
        "",
        "你必须严格返回以下 JSON 对象格式：",
        "{",
        '  "conversations": [{"time_span": "2026/6/5-2026/6/6", "topic": "标签", "summary": "摘要"}],',
        '  "user_facts": [{"last_confirmed": "2026/6/6", "fact": "事实 1"}],',
        '  "system_facts": [{"last_confirmed": "2026/6/6", "kind": "agent_rule", "fact": "规则 1"}]',
        "}",
    ].join("\n");

    #condenseBuffer(): void {
        const content = this.#readHistory();
        if (content.length <= HistoryManager.KEEP_RECENT_CHARS) return;

        const toKeep = content.slice(-HistoryManager.KEEP_RECENT_CHARS);
        const toCondense = content.slice(0, -HistoryManager.KEEP_RECENT_CHARS);

        if (toCondense.length < 500) return;
        console.log("  [历史] 正在批量浓缩...");

        // 安全截断：寻找最近的对话边界，避免切断单句话
        let condenseInput = toCondense;
        if (condenseInput.length > HistoryManager.MAX_CONDENSE_PAYLOAD) {
            const truncated = condenseInput.slice(-HistoryManager.MAX_CONDENSE_PAYLOAD);
            const nextSessionIdx = truncated.indexOf("\n## 会话 ");
            const nextLineIdx = truncated.indexOf("\n\n");
            
            if (nextSessionIdx > 0) {
                condenseInput = truncated.slice(nextSessionIdx);
            } else if (nextLineIdx > 0) {
                condenseInput = truncated.slice(nextLineIdx);
            } else {
                condenseInput = truncated; 
            }
        }

        const currentTimeStr = new Date().toLocaleString("zh-CN");
        const prompt = `【系统当前时间】：${currentTimeStr}\n\n` + HistoryManager.BATCH_CONDENSE_PROMPT + "\n=== 对话记录 ===\n" + condenseInput;

        this.#callLLMCondense(prompt, toKeep);
    }

    async #callLLMCondense(prompt: string, toKeep: string): Promise<void> {
        try {
            const response = await llmClient.chat.completions.create({
                model: targetModel,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3, 
                stream: false,
            });

            const text = response.choices[0]?.message?.content?.trim() ?? "";
            const { conversations, facts, systemFacts } = this.#parseBatchResult(text);
            
            if (conversations.length > 0) {
                this.#insertCondensed(conversations);
                console.log(`  [历史] 归档了 ${conversations.length} 条话题记录`);
            }

            if (facts.length > 0) {
                const kept = this.#mergeUserFacts(facts);
                if (kept > 0) {
                    this.#condenseUserMemory();
                    console.log(`  [user] 保存了 ${kept} 条稳定事实`);
                }
            }

            if (systemFacts.length > 0) {
                const kept = this.#mergeSystemFacts(systemFacts);
                if (kept > 0) {
                    this.#condenseSystemMemory();
                    console.log(`  [memory] 保存了 ${kept} 条操作经验`);
                }
            }

            let finalKeep = toKeep;
            const boundary = toKeep.indexOf("\n## 会话 ");
            if (boundary > 0) finalKeep = toKeep.slice(boundary);
            
            await fs.writeFile(this.historyPath, finalKeep, "utf-8");
        } catch (e) {
            console.log(`  [历史] 浓缩失败: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    #parseBatchResult(text: string) {
        let cleaned = text;
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.split("\n").slice(1).join("\n");
            if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
            cleaned = cleaned.trim();
        }

        try {
            const data = JSON.parse(cleaned);
            if (typeof data === "object" && data !== null) {
                const conversations = Array.isArray(data.conversations)
                    ? data.conversations.filter((e: any) => e && typeof e.summary === "string").map((e: any) => ({
                          time_span: String(e.time_span || ""),
                          topic: String(e.topic || ""),
                          summary: String(e.summary)
                      }))
                    : [];
                    
                const facts = Array.isArray(data.user_facts)
                    ? data.user_facts.filter((f: any) => f && typeof f.fact === "string").map((f: any) => ({
                          last_confirmed: String(f.last_confirmed || ""),
                          fact: String(f.fact)
                      }))
                    : [];

                const systemFacts = Array.isArray(data.system_facts)
                    ? data.system_facts.filter((f: any) => f && typeof f.fact === "string").map((f: any) => ({
                          last_confirmed: String(f.last_confirmed || ""),
                          kind: String(f.kind || ""),
                          fact: String(f.fact),
                      }))
                    : [];
                     
                return { conversations, facts, systemFacts };
            }
        } catch {
            return { conversations: this.#parseBatchFallback(cleaned), facts: [], systemFacts: [] };
        }
        return { conversations: [], facts: [], systemFacts: [] };
    }

    #parseBatchFallback(text: string): Array<{ time_span?: string; topic: string; summary: string }> {
        const entries: Array<{ time_span?: string; topic: string; summary: string }> = [];
        const blockRegex = /\{[^}]*\}/g;
        let match;
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
                if (summary.trim()) entries.push({ time_span: timeM?.[1] ?? "", topic: topicM?.[1] ?? "", summary: summary.trim() });
            }
        }
        return entries;
    }

    search(query: string, limit = 5): string {
        const conn = this.#getConn();
        const rows = conn.prepare(
            "SELECT session_id, timestamp, topic, summary FROM conversations WHERE summary LIKE ? OR topic LIKE ? ORDER BY timestamp DESC LIMIT ?",
        ).all(`%${query}%`, `%${query}%`, limit) as Array<{ session_id: string; timestamp: number; topic: string; summary: string; }>;

        if (rows.length === 0) return `未找到与 '${query}' 相关的历史记录。`;

        const lines = [`搜索 '${query}' 找到 ${rows.length} 条记录：`];
        for (const row of rows) {
            const timeStr = new Date(row.timestamp * 1000).toLocaleString("zh-CN");
            lines.push(`[${timeStr}] ${row.topic ? `[${row.topic}] ` : ""}(${row.session_id}): ${row.summary}`);
        }
        return lines.join("\n");
    }

    getRecent(limit = 10): string {
        const parts: string[] = [];
        const conn = this.#getConn();
        const rows = conn.prepare("SELECT topic, summary FROM conversations ORDER BY timestamp DESC LIMIT ?").all(limit) as Array<{ topic: string; summary: string }>;

        if (rows.length > 0) {
            parts.push("=== 浓缩历史 ===");
            for (const row of [...rows].reverse()) parts.push(`${row.topic ? `[${row.topic}] ` : ""}${row.summary}`);
        }

        const raw = this.#readHistory();
        if (raw) {
            const sessions = raw.split("\n## 会话 ");
            const recentSessions = sessions.slice(-2);
            const recentText = "\n## 会话 ".repeat(recentSessions.length > 1 ? 1 : 0) + recentSessions.join("\n## 会话 ");
            const tail = recentText.trim().split("\n").slice(-30).join("\n");
            if (tail.trim()) {
                parts.push("\n=== 最近原始对话 ===");
                parts.push(tail);
            }
        }
        return parts.length > 0 ? parts.join("\n") : "暂无历史记录。";
    }

    getRecentHistory(limit = 10): string { return this.getRecent(limit); }

    getStats() {
        const conn = this.#getConn();
        const countRow = conn.prepare("SELECT COUNT(*) as count FROM conversations").get() as { count: number };
        const oldestRow = conn.prepare("SELECT MIN(timestamp) as d FROM conversations").get() as { d: number | null };
        const newestRow = conn.prepare("SELECT MAX(timestamp) as d FROM conversations").get() as { d: number | null };

        return {
            conversationCount: countRow.count,
            dbSizeKB: this.#safeStatSize(this.dbPath),
            oldestDate: oldestRow.d ? new Date(oldestRow.d * 1000).toLocaleString("zh-CN") : "-",
            newestDate: newestRow.d ? new Date(newestRow.d * 1000).toLocaleString("zh-CN") : "-",
        };
    }

    getBufferStats() {
        const charCount = Buffer.byteLength(this.#readHistory(), "utf-8");
        return {
            exists: charCount > 0,
            charCount,
            threshold: HistoryManager.MAX_BUFFER_CHARS,
            percentUsed: Math.round((charCount / HistoryManager.MAX_BUFFER_CHARS) * 100),
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

    checkAndCondense(): boolean {
        let didCondense = false;
        if (this.#bufferSize() > HistoryManager.MAX_BUFFER_CHARS) {
            this.#safeCondense();
            didCondense = true;
        }
        if (this.#condenseUserMemory()) didCondense = true;
        if (this.#condenseSystemMemory()) didCondense = true;
        return didCondense;
    }
}