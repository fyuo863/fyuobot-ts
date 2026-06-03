// src/slash/registry.ts
//
// CommandRegistry：斜杠命令的注册、自动发现、搜索和补全。
// 设计模式与 ToolRegistry 保持一致——自动发现目录下的 .ts 文件，
// 动态 import() 遍历导出，找出实现 SlashCommand 接口的对象。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SlashCommand, CommandContext, CommandResult } from "./types.js";

/** 判断导出值是否为 SlashCommand 对象 */
function isSlashCommand(value: unknown): value is SlashCommand {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).name === "string" &&
        typeof (value as Record<string, unknown>).description === "string" &&
        typeof (value as Record<string, unknown>).execute === "function"
    );
}

export class CommandRegistry {
    /** 主名称 → 命令 */
    #commands = new Map<string, SlashCommand>();
    /** 别名 → 主名称 */
    #aliases = new Map<string, string>();

    // ── 注册 ────────────────────────────────────────────

    /** 注册一个命令（含别名）。重名时静默跳过，返回 false。 */
    register(cmd: SlashCommand): boolean {
        if (this.#commands.has(cmd.name)) return false;

        this.#commands.set(cmd.name, cmd);

        for (const alias of cmd.aliases ?? []) {
            if (!this.#aliases.has(alias)) {
                this.#aliases.set(alias, cmd.name);
            }
        }
        return true;
    }

    // ── 查询 ────────────────────────────────────────────

    /** 按前缀搜索匹配命令，返回匹配的命令列表（用于补全建议） */
    search(prefix: string): SlashCommand[] {
        const lower = prefix.toLowerCase();
        const seen = new Set<string>();
        const result: SlashCommand[] = [];

        // 匹配主名称
        for (const [name, cmd] of this.#commands) {
            if (name.startsWith(lower)) {
                seen.add(name);
                result.push(cmd);
            }
        }

        // 匹配别名
        for (const [alias, name] of this.#aliases) {
            if (alias.startsWith(lower) && !seen.has(name)) {
                seen.add(name);
                const cmd = this.#commands.get(name);
                if (cmd) result.push(cmd);
            }
        }

        return result;
    }

    /** 按名称查找命令（先查主名称，再查别名） */
    get(name: string): SlashCommand | undefined {
        const cmd = this.#commands.get(name);
        if (cmd) return cmd;

        const mainName = this.#aliases.get(name);
        if (mainName) return this.#commands.get(mainName);

        return undefined;
    }

    /** 返回所有唯一命令 */
    getAll(): SlashCommand[] {
        return [...this.#commands.values()];
    }

    /** 已注册命令数（不含别名） */
    get size(): number {
        return this.#commands.size;
    }

    // ── 执行 ────────────────────────────────────────────

    /**
     * 执行命令。
     * 找不到命令时返回 `{ type: "error", message: "..." }`，不抛异常。
     */
    async execute(name: string, ctx: CommandContext): Promise<CommandResult> {
        const cmd = this.get(name);
        if (!cmd) {
            // 尝试模糊匹配，给出建议
            const suggestions = this.search(name);
            const hint =
                suggestions.length > 0
                    ? `，你要找的是不是: ${suggestions.map((c) => "/" + c.name).join(", ")}`
                    : "";
            return { type: "error", message: `未知命令: /${name}${hint}` };
        }

        try {
            return await cmd.execute(ctx);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { type: "error", message: `命令 /${name} 执行失败: ${msg}` };
        }
    }

    // ── 自动发现 ────────────────────────────────────────

    /**
     * 扫描目录下的 .ts/.js 文件，动态导入并注册所有 SlashCommand。
     * 跳过以 `_` 或 `.` 开头的文件（禁用/隐藏文件）。
     */
    async discoverAndRegister(dirUrl: URL): Promise<number> {
        let count = 0;
        const dirPath = fileURLToPath(dirUrl);

        let entries: string[];
        try {
            entries = readdirSync(dirPath);
        } catch {
            return 0; // 目录不存在，静默跳过
        }

        // 按字母排序保证确定性加载
        const sorted = entries.filter(
            (f) => !f.startsWith("_") && !f.startsWith(".") && /\.(?:ts|js)$/.test(f),
        ).sort();

        for (const file of sorted) {
            try {
                const filePath = join(dirPath, file);
                const fileUrl = pathToFileURL(filePath).href;
                const mod = await import(fileUrl);

                for (const value of Object.values(mod)) {
                    if (isSlashCommand(value)) {
                        if (this.register(value)) {
                            count++;
                        }
                    }
                }
            } catch (err) {
                // 单个文件加载失败不影响其他命令
                console.warn(`[slash] 加载命令失败: ${file} —`, err instanceof Error ? err.message : String(err));
            }
        }

        return count;
    }
}
