// src/tools/memory-tool.ts
// 记忆工具 —— 读写 .fyuobot/memories/ 下的记忆文件
//
// 三个记忆文件：
//   HISTORY.md — 对话历史记录
//   MEMORY.md  — 系统设置
//   USER.md    — 用户偏好

import * as fs from "fs/promises";
import * as path from "path";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

/** 记忆文件名称 → 文件名的映射 */
const MEMORY_FILES: Record<string, string> = {
    history: "HISTORY.md",
    memory: "MEMORY.md",
    user: "USER.md",
};

/** 记忆文件的基础目录（相对于 cwd） */
const MEMORIES_DIR = path.resolve(process.cwd(), ".fyuobot", "memories");

export class MemoryTool extends BaseTool {
    name = "memory";
    description = [
        "读写 Agent 的记忆文件与 SQLite 历史归档。",
        "",
        "记忆文件（.fyuobot/memories/）：",
        "- history: 对话历史缓冲区（HISTORY.md），超阈值自动归档到 SQLite",
        "- memory: 系统设置（MEMORY.md）",
        "- user: 用户偏好（USER.md）",
        "",
        "操作：",
        "- read: 读取指定记忆文件",
        "- write: 覆盖写入指定记忆文件",
        "- append: 向指定记忆文件末尾追加内容",
        "- search: 搜索 SQLite 历史归档（仅对 history 有效）",
        "- stats: 查看 SQLite 历史数据库统计信息",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "file",
            type: "string",
            description: "要操作的记忆文件：'history'（对话记录）、'memory'（系统设置）、'user'（用户偏好）",
            required: true,
            enum: ["history", "memory", "user"],
        },
        {
            name: "action",
            type: "string",
            description: "操作类型：'read'（读取）、'write'（覆盖写入）、'append'（追加）、'search'（搜索归档）、'stats'（数据库统计）",
            required: true,
            enum: ["read", "write", "append", "search", "stats"],
        },
        {
            name: "content",
            type: "string",
            description: "写入/追加的内容（write/append 时必需），或搜索关键词（search 时必需）",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const file = args["file"] as string;
        const action = args["action"] as string;
        const content = args["content"] as string | undefined;

        const fileName = MEMORY_FILES[file];
        if (!fileName) {
            return `❌ 未知的记忆文件: "${file}"，可选值: history, memory, user`;
        }

        // SQLite 操作（仅对 history 有效）
        if (action === "search" || action === "stats") {
            return this.#handleSQLiteAction(file, action, content);
        }

        const filePath = path.join(MEMORIES_DIR, fileName);

        try {
            // 确保目录存在
            await fs.mkdir(MEMORIES_DIR, { recursive: true });

            switch (action) {
                case "read": {
                    let data: string;
                    try {
                        data = await fs.readFile(filePath, "utf-8");
                    } catch {
                        return `📄 ${fileName} 为空或不存在。`;
                    }
                    const size = Buffer.byteLength(data, "utf-8");
                    const truncated =
                        size > 8000
                            ? data.slice(0, 8000) +
                              `\n\n... (文件过大，已截断。完整大小: ${(size / 1024).toFixed(1)} KB，请使用 compress 工具压缩归档)`
                            : data;
                    return truncated;
                }

                case "write": {
                    if (content === undefined) {
                        return "❌ write 操作需要提供 content 参数。";
                    }
                    await fs.writeFile(filePath, content, "utf-8");
                    const size = Buffer.byteLength(content, "utf-8");
                    return `✅ 已覆盖写入 ${fileName}（${(size / 1024).toFixed(1)} KB）。`;
                }

                case "append": {
                    if (content === undefined) {
                        return "❌ append 操作需要提供 content 参数。";
                    }
                    let existing = "";
                    try {
                        existing = await fs.readFile(filePath, "utf-8");
                    } catch {
                        // 文件不存在，从头创建
                    }
                    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
                    await fs.writeFile(filePath, existing + separator + content, "utf-8");
                    const totalSize = Buffer.byteLength(existing + separator + content, "utf-8");
                    return `✅ 已追加到 ${fileName}（总大小: ${(totalSize / 1024).toFixed(1)} KB）。`;
                }

                default:
                    return `❌ 未知的操作: "${action}"，可选值: read, write, append, search, stats`;
            }
        } catch (e) {
            return `❌ 记忆操作失败: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    /** 处理 SQLite 历史归档查询 */
    async #handleSQLiteAction(
        file: string,
        action: string,
        content: string | undefined,
    ): Promise<string> {
        if (file !== "history") {
            return `❌ ${action} 操作仅对 history 文件有效。`;
        }

        const { HistoryManager } = await import("./history-manager.js");
        const hm = HistoryManager.instance();

        if (action === "stats") {
            const stats = hm.getStats();
            const buf = hm.getBufferStats();

            return [
                "📊 SQLite 历史数据库统计:",
                `   路径: .fyuobot/history/history.db`,
                `   浓缩记录: ${stats.conversationCount} 条`,
                `   时间范围: ${stats.oldestDate} ~ ${stats.newestDate}`,
                `   数据库大小: ${stats.dbSizeKB} KB`,
                ``,
                `HISTORY.md 缓冲区: ${(buf.charCount / 1024).toFixed(1)} KB / ${(buf.threshold / 1024).toFixed(0)} KB (${buf.percentUsed}%)`,
            ].join("\n");
        }

        if (action === "search") {
            if (!content) {
                return "❌ search 操作需要提供 content 参数（搜索关键词）。";
            }
            return hm.search(content, 15);
        }

        return `❌ 未知的 SQLite 操作: "${action}"`;
    }
}
