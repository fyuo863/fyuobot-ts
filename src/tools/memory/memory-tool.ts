import * as fs from "fs/promises";
import * as path from "path";
import { BaseTool } from "../basetool.js";
import type { ToolParam } from "../basetool.js";

const MEMORY_FILES: Record<string, string> = {
    history: "HISTORY.md",
    memory: "MEMORY.md",
    user: "USER.md",
};

const MEMORIES_DIR = path.resolve(process.cwd(), ".fyuobot", "memories");

export class MemoryTool extends BaseTool {
    name = "memory";
    description = [
        "读写 Agent 的记忆文件与 SQLite 历史归档。",
        "",
        "必须先判断内容归属，再选择 file：",
        "- user / USER.md: 只保存用户个人层面的长期事实和偏好。",
        "  例：沟通风格、语言偏好、确认偏好、用户个人开发习惯、用户明确说“我喜欢/我希望/以后都...”的稳定偏好。",
        "- memory / MEMORY.md: 保存系统和项目层面的长期规则。",
        "  例：本项目架构决策、工具注册规则、sub-agent 策略、热更新策略、记忆系统规则、代码库约定、工作流要求。",
        "- history / HISTORY.md: 原始对话缓冲区，通常由系统自动写入；不要手动追加普通偏好或系统规则。",
        "",
        "判断原则：",
        "- 内容主语是“用户本人”或用户个人偏好 -> USER.md。",
        "- 内容主语是“agent/系统/项目/工具/代码库/工作流” -> MEMORY.md。",
        "- 如果不确定，优先写 MEMORY.md，不要污染 USER.md。",
        "",
        "操作：read 读取；write 覆盖；append 追加；search 搜索 SQLite 历史归档；stats 查看统计。",
        "Use action=recent with file=history when the user refers to 上条/刚才/上一轮/previous turn; recent reads the hot HISTORY.md buffer, while search only queries condensed SQLite archives.",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "file",
            type: "string",
            description: [
                "目标记忆文件。",
                "user=USER.md，仅限用户个人长期偏好/个人事实。",
                "memory=MEMORY.md，用于系统规则、项目规则、工具行为、agent 工作流和代码库约定。",
                "history=HISTORY.md，对话历史缓冲区；search/stats 只对 history 有效。",
            ].join(" "),
            required: true,
            enum: ["history", "memory", "user"],
        },
        {
            name: "action",
            type: "string",
            description:
                "操作类型：read、write、append、recent、search、stats。Use recent for the latest hot conversation context.",
            required: true,
            enum: ["read", "write", "append", "recent", "search", "stats"],
        },
        {
            name: "content",
            type: "string",
            description: [
                "write/append 的写入内容，或 search 的搜索关键词。",
                "写入前必须按内容归属选择 file：个人偏好写 user；系统/项目/工具/工作流规则写 memory。",
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
            return `未知的记忆文件: "${file}"，可选值: history, memory, user`;
        }

        if (action === "search" || action === "stats" || action === "recent") {
            return this.#handleSQLiteAction(file, action, content);
        }

        const filePath = path.join(MEMORIES_DIR, fileName);

        try {
            await fs.mkdir(MEMORIES_DIR, { recursive: true });

            switch (action) {
                case "read": {
                    let data: string;
                    try {
                        data = await fs.readFile(filePath, "utf-8");
                    } catch {
                        return `${fileName} 为空或不存在。`;
                    }
                    const size = Buffer.byteLength(data, "utf-8");
                    if (size <= 8000) return data;
                    return (
                        data.slice(0, 8000) +
                        `\n\n... (文件过大，已截断。完整大小: ${(size / 1024).toFixed(1)} KB，请使用 compress 工具压缩归档)`
                    );
                }

                case "write": {
                    if (content === undefined) {
                        return "write 操作需要提供 content 参数。";
                    }
                    const guard = this.#guardMemoryTarget(file, content);
                    if (guard) return guard;

                    await fs.writeFile(filePath, content, "utf-8");
                    const size = Buffer.byteLength(content, "utf-8");
                    return `已覆盖写入 ${fileName}（${(size / 1024).toFixed(1)} KB）。`;
                }

                case "append": {
                    if (content === undefined) {
                        return "append 操作需要提供 content 参数。";
                    }
                    const guard = this.#guardMemoryTarget(file, content);
                    if (guard) return guard;

                    let existing = "";
                    try {
                        existing = await fs.readFile(filePath, "utf-8");
                    } catch {
                        // File does not exist yet.
                    }
                    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
                    const next = existing + separator + content;
                    await fs.writeFile(filePath, next, "utf-8");
                    const totalSize = Buffer.byteLength(next, "utf-8");
                    return `已追加到 ${fileName}（总大小 ${(totalSize / 1024).toFixed(1)} KB）。`;
                }

                default:
                    return `未知的操作: "${action}"，可选值: read, write, append, search, stats`;
            }
        } catch (e) {
            return `记忆操作失败: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    #guardMemoryTarget(file: string, content: string): string | undefined {
        if (file !== "user") return undefined;
        if (!this.#looksLikeSystemMemory(content)) return undefined;
        if (this.#looksLikePersonalUserMemory(content)) return undefined;

        return [
            "拒绝写入 USER.md：这段内容更像系统/项目/工具/工作流规则，应写入 MEMORY.md。",
            "",
            "分类边界：",
            "- USER.md: 用户个人偏好、个人事实、沟通风格。",
            "- MEMORY.md: agent 行为规则、项目约定、工具策略、代码库长期设置。",
            "",
            "请改用：memory(file=\"memory\", action=\"append\" 或 \"write\", content=...)",
        ].join("\n");
    }

    #looksLikeSystemMemory(content: string): boolean {
        const text = content.toLowerCase();
        return /(agent|sub-agent|tool|mcp|registry|prompt|system|memory\.md|user\.md|history\.md|hot reload|cache|workflow|codebase|repo|project|工具|系统|项目|代码库|工作流|提示词|热更新|注册|上下文|缓存|记忆系统)/.test(text);
    }

    #looksLikePersonalUserMemory(content: string): boolean {
        const text = content.toLowerCase();
        return /(用户|user|我|个人|偏好|喜欢|希望|沟通|语言|风格|确认|approval|prefer|preference|like|want|my\b|me\b)/.test(text);
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
            const history = hm.getBufferStats();
            const memory = hm.getSystemMemoryStats();
            const user = hm.getUserMemoryStats();

            return [
                "SQLite 历史数据库统计",
                "路径: .fyuobot/history/history.db",
                `浓缩记录: ${stats.conversationCount} 条`,
                `时间范围: ${stats.oldestDate} ~ ${stats.newestDate}`,
                `数据库大小: ${stats.dbSizeKB} KB`,
                "",
                `HISTORY.md: ${(history.charCount / 1024).toFixed(1)} KB / ${(history.threshold / 1024).toFixed(0)} KB (${history.percentUsed}%)`,
                `MEMORY.md: ${(memory.charCount / 1024).toFixed(1)} KB / ${(memory.threshold / 1024).toFixed(0)} KB (${memory.percentUsed}%)`,
                `USER.md: ${(user.charCount / 1024).toFixed(1)} KB / ${(user.threshold / 1024).toFixed(0)} KB (${user.percentUsed}%)`,
            ].join("\n");
        }

        if (action === "search") {
            if (!content) {
                return "search 操作需要提供 content 参数（搜索关键词）。";
            }
            return hm.search(content, 15);
        }

        if (action === "recent") {
            return hm.getRecentHistory(10);
        }

        return `未知的 SQLite 操作: "${action}"`;
    }
}
