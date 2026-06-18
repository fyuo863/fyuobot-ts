import * as fs from "fs/promises";
import * as path from "path";
import { BaseTool } from "../basetool.js";
import type { ToolParam } from "../basetool.js";
import { resolveProjectAgentPath } from "../../config/agent-paths.js";

const MEMORY_FILES: Record<string, string> = {
    history: "history.db",
    memory: "MEMORY.md",
    user: "USER.md",
};

const MEMORY_STRONG_TRANSIENT_PATTERNS: RegExp[] = [
    /(测试通过|测试失败|全部 \d+ 项测试通过|用例|test case|pass(ed)?|fail(ed)?)/i,
    /(已创建|已发布|创建了|发布了|created|published|发布文章|博客文章|ID=\d+)/i,
    /(修复了|已修复|fix(ed)?|报错|错误日志|异常栈|stack trace)/i,
];

const MEMORY_WEAK_TRANSIENT_PATTERNS: RegExp[] = [
    /(位于\s+.+|目录下|路径[:：]\s*.+|存放至\s+.+|写入\s+.+目录)/i,
    /(本次|这次|当前|刚刚|刚才|临时|一次性|排查|调试|为了这次)/i,
    /(spawn|detached|stdio|Playwright|CDP).*(修复|问题|窗口|控制台)/i,
];

const MEMORY_DURABLE_PATTERNS: RegExp[] = [
    /(必须|不要|禁止|统一|默认|以后|始终|一律|仅|只允许|优先|改用|应当|应该|建议)/,
    /(规则|策略|约定|流程|工作流|行为|规范|存放规则|推送策略|审批策略|重启后任务接力)/,
];

export class MemoryTool extends BaseTool {
    name = "memory";
    description = [
        "读写 Agent 的分层记忆。",
        "",
        "必须先判断内容归属，再选择 file：",
        "- user / USER.md: 只保存用户个人层面的长期事实和偏好。",
        "  例：沟通风格、语言偏好、确认偏好、用户个人开发习惯、用户明确说“我喜欢/我希望/以后都...”的稳定偏好。",
        "- memory / MEMORY.md: 保存系统和项目层面的长期规则。",
        "  例：本项目架构决策、工具注册规则、sub-agent 策略、热更新策略、记忆系统规则、代码库约定、工作流要求。",
        "- history / history.db: 自动记录的情节记忆，只能查询，不能手动写入。",
        "  每轮自动保存 id、session_id、turn_id、date、time_24h、timestamp、ask、tool_name、tool_used、answer。",
        "- trial_candidates.json: 高试错轮次候选列表，保存对应的 history.db 记录 id。",
        "",
        "判断原则：",
        "- 是否写入 USER.md 由 agent 自己判断。",
        "- USER.md 的分区也由 agent 在写入内容时自行决定。",
        "- 如果内容是系统、项目、工具、工作流规则，应写入 MEMORY.md。",
        "",
        "操作：read 读取；write 覆盖；append 追加；recent 读最近轮次；day 按日期回忆；search 搜索历史；stats 查看统计；candidates 查看高试错轮次候选。",
        "Use action=day with file=history when the user asks 某天/今天/昨天具体做了什么.",
        "Use action=recent with file=history when the user refers to 上条/刚才/上一轮/previous turn.",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "file",
            type: "string",
            description: [
                "目标记忆文件。",
                "user=USER.md，仅限用户个人长期偏好/个人事实。",
                "memory=MEMORY.md，用于系统规则、项目规则、工具行为、agent 工作流和代码库约定。",
                "history=history.db，程序自动写入的对话与活动记录；read/recent/day/search/stats/candidates 只对 history 有效。",
            ].join(" "),
            required: true,
            enum: ["history", "memory", "user"],
        },
        {
            name: "action",
            type: "string",
            description:
                "操作类型：read、write、append、recent、day、search、stats、candidates。Use day for a specific date and recent for latest turns.",
            required: true,
            enum: ["read", "write", "append", "recent", "day", "search", "stats", "candidates"],
        },
        {
            name: "content",
            type: "string",
            description: [
                "write/append 的写入内容、search 的搜索关键词，或 day 的日期（如 2026-06-09、6月9日、今天、昨天）。",
                "写入前必须按内容归属选择 file：用户长期事实写 user；系统/项目/工具/工作流规则写 memory。",
            ].join(" "),
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const file = args["file"] as string;
        const action = args["action"] as string;
        const content = args["content"] as string | undefined;

        const fileName = MEMORY_FILES[file];
        if (!fileName) {
            return `未知的记忆文件 "${file}"，可选值: history, memory, user`;
        }

        if (file === "history") {
            if (action === "write" || action === "append") {
                return "history.db 由程序自动记录，不能通过 memory 工具手动写入。请把长期用户偏好写入 USER.md，把系统/项目设置写入 MEMORY.md。";
            }
            return this.#handleSQLiteAction(file, action, content);
        }

        if (action === "search" || action === "stats" || action === "recent" || action === "day" || action === "candidates") {
            return `${action} 操作仅对 history 文件有效。`;
        }

        const memoriesDir = resolveProjectAgentPath("memories");
        const filePath = path.join(memoriesDir, fileName);
        const { HistoryManager } = await import("../../memory/history-manager.js");
        const hm = HistoryManager.instance();

        try {
            await fs.mkdir(memoriesDir, { recursive: true });

            switch (action) {
                case "read": {
                    let data: string;
                    try {
                        data = await fs.readFile(filePath, "utf-8");
                    } catch {
                        return `${fileName} 为空或不存在。`;
                    }
                    const size = Buffer.byteLength(data, "utf-8");
                    if (size <= 8000) return this.#formatTaggedBlock(file, data);
                    return (
                        this.#formatTaggedBlock(file, data.slice(0, 8000)) +
                        `\n\n... (文件过大，已截断。完整大小 ${(size / 1024).toFixed(1)} KB，请使用 compress 工具压缩归档)`
                    );
                }

                case "write": {
                    if (content === undefined) {
                        return "write 操作需要提供 content 参数。";
                    }
                    const guard = this.#guardMemoryTarget(file);
                    if (guard) return guard;
                    const memoryGuard = this.#guardMemoryContent(file, content);
                    if (memoryGuard) return memoryGuard;

                    const next = file === "user" || file === "memory"
                        ? hm.normalizeMemoryDocument(file, content)
                        : content;
                    await fs.writeFile(filePath, next, "utf-8");
                    const size = Buffer.byteLength(next, "utf-8");
                    return `已覆盖写入 ${fileName}（${(size / 1024).toFixed(1)} KB）。`;
                }

                case "append": {
                    if (content === undefined) {
                        return "append 操作需要提供 content 参数。";
                    }
                    const guard = this.#guardMemoryTarget(file);
                    if (guard) return guard;
                    const memoryGuard = this.#guardMemoryContent(file, content);
                    if (memoryGuard) return memoryGuard;

                    let existing = "";
                    try {
                        existing = await fs.readFile(filePath, "utf-8");
                    } catch {
                        // File does not exist yet.
                    }
                    const separator =
                        existing && !existing.endsWith("\n") ? "\n" : "";
                    const merged = existing + separator + content;
                    const next = file === "user" || file === "memory"
                        ? hm.normalizeMemoryDocument(file, merged)
                        : merged;
                    await fs.writeFile(filePath, next, "utf-8");
                    const totalSize = Buffer.byteLength(next, "utf-8");
                    return `已追加到 ${fileName}（总大小 ${(totalSize / 1024).toFixed(1)} KB）。`;
                }

                default:
                    return `未知的操作 "${action}"，可选值: read, write, append, recent, day, search, stats, candidates`;
            }
        } catch (e) {
            return `记忆操作失败: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    #guardMemoryTarget(file: string): string | undefined {
        if (file !== "history") return undefined;
        return [
            "history.db 由程序自动记录，不能通过 memory 工具手动写入。",
            "请把用户长期事实写入 USER.md，把系统/项目设置写入 MEMORY.md。",
        ].join("\n");
    }

    #guardMemoryContent(file: string, content: string): string | undefined {
        if (file !== "memory") return undefined;

        const lines = content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith("- "));

        if (lines.length === 0) {
            return [
                "MEMORY.md 只接受结构化长期规则条目。",
                "请使用格式：- [YYYY/M/D] [Agent Rules|Project Rules|Tooling|Historical Notes] 内容",
            ].join("\n");
        }

        for (const line of lines) {
            if (!/\[(Agent Rules|Project Rules|Tooling|Historical Notes)\]/i.test(line)) {
                return [
                    "MEMORY.md 条目必须显式标注分区。",
                    "请使用格式：- [YYYY/M/D] [Agent Rules|Project Rules|Tooling|Historical Notes] 内容",
                ].join("\n");
            }

            const normalized = line.replace(/^-\s*/, "");
            const hasDurableSignals = MEMORY_DURABLE_PATTERNS.some((pattern) => pattern.test(normalized));
            const hasStrongTransientSignals = MEMORY_STRONG_TRANSIENT_PATTERNS.some((pattern) => pattern.test(normalized));
            const hasWeakTransientSignals = MEMORY_WEAK_TRANSIENT_PATTERNS.some((pattern) => pattern.test(normalized));

            // 长期规则经常会带目录/路径描述，只有在缺少规则信号时才把这类线索视为临时记录。
            if (hasStrongTransientSignals || (!hasDurableSignals && hasWeakTransientSignals)) {
                return [
                    "已拒绝写入 MEMORY.md：内容看起来是一次性任务记录、测试/发布日志或临时排查信息。",
                    "即使标记为 Historical Notes，这类内容也应该保留在 history.db，而不是进入长期设置记忆。",
                ].join("\n");
            }

            if (!hasDurableSignals) {
                return [
                    "已拒绝写入 MEMORY.md：内容不像长期生效的设置/规则。",
                    "只有未来多轮对话都应继续生效的规则、策略、默认行为，才应写入 MEMORY.md。",
                ].join("\n");
            }
        }

        return undefined;
    }

    async #handleSQLiteAction(
        file: string,
        action: string,
        content: string | undefined,
    ): Promise<string> {
        if (file !== "history") {
            return `${action} 操作仅对 history 文件有效。`;
        }

        const { HistoryManager } = await import("../../memory/history-manager.js");
        const hm = HistoryManager.instance();

        if (action === "stats") {
            const stats = hm.getStats();
            const memory = hm.getSystemMemoryStats();
            const user = hm.getUserMemoryStats();

            return [
                "[history] SQLite 历史数据库统计",
                "路径: .fyuobot/history/history.db",
                `原始轮次: ${stats.turnCount} 条`,
                `每日活动: ${stats.activityCount} 条`,
                `高试错候选: ${stats.candidateCount} 条`,
                `时间范围: ${stats.oldestDate} ~ ${stats.newestDate}`,
                `数据库大小: ${stats.dbSizeKB} KB`,
                "候选文件: .fyuobot/history/trial_candidates.json",
                "",
                `[memory] MEMORY.md: ${(memory.charCount / 1024).toFixed(1)} KB / ${(memory.threshold / 1024).toFixed(0)} KB (${memory.percentUsed}%)`,
                `[user] USER.md: ${(user.charCount / 1024).toFixed(1)} KB / ${(user.threshold / 1024).toFixed(0)} KB (${user.percentUsed}%)`,
            ].join("\n");
        }

        if (action === "search") {
            if (!content) {
                return "search 操作需要提供 content 参数（搜索关键词）。";
            }
            return this.#formatTaggedBlock("history", hm.search(content, 15));
        }

        if (action === "candidates") {
            return this.#formatTaggedBlock("history", hm.getHighTrialCandidates(20));
        }

        if (action === "day") {
            if (!content) {
                return "day 操作需要提供 content 参数（日期，如 2026-06-09、6月9日、今天、昨天）。";
            }
            return this.#formatTaggedBlock("history", hm.getDayHistory(content, 80));
        }

        if (action === "recent" || action === "read") {
            return this.#formatTaggedBlock("history", hm.getRecentHistory(10));
        }

        return `未知的 SQLite 操作: "${action}"`;
    }

    #formatTaggedBlock(file: string, content: string): string {
        return `[${file}]\n${content}`;
    }
}
