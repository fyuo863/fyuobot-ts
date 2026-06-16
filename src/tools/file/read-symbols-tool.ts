// src/tools/file/read-symbols-tool.ts
//
// ReadSymbolsTool — 扫描代码文件中的顶级符号（函数、类、接口、类型、枚举等）
// 及其所在行号。在修改陌生大文件前，应先使用此工具了解文件结构，
// 然后再用 read_file_lines 按行号查看具体实现。

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { BaseTool, type ToolParam } from "../basetool.js";
import {
    parseAllowOutsideWorkspace,
    resolveWorkspacePath,
} from "./workspace-path.js";

export class ReadSymbolsTool extends BaseTool {
    name = "read_file_symbols";
    description =
        "扫描文件中所有顶级符号及其行号（支持 TS/JS、Python、Go、Rust、Java 等多语言）。在修改陌生大文件前先用此工具了解骨架结构，再用 read_file_lines 查看具体实现。";
    requiresConfirmation(args: Record<string, unknown>): boolean {
        return parseAllowOutsideWorkspace(args.allow_outside_workspace);
    }
    parameters: ToolParam[] = [
        {
            name: "filepath",
            type: "string",
            description: "要扫描的文件路径（相对或绝对）",
            required: true,
        },
        {
            name: "allow_outside_workspace",
            type: "boolean",
            description: "允许读取工作区外路径。默认 false，显式为 true 时会触发确认。",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const filepath = String(args.filepath ?? "");

        if (!filepath) return "错误：缺少 filepath 参数。";

        try {
            const absolutePath = resolveWorkspacePath(
                filepath,
                parseAllowOutsideWorkspace(args.allow_outside_workspace),
            );
            const content = await readFile(absolutePath, "utf-8");
            const lines = content.split("\n");
            const ext = extname(filepath).toLowerCase();

            const symbols: Array<{ line: number; text: string }> = [];

            // ════════════════════════════════════════════════════════
            // 多语言符号匹配规则路由
            // ════════════════════════════════════════════════════════
            let patterns: Array<{ regex: RegExp; label?: string }> = [];

            switch (ext) {
                case ".py":
                    patterns = [
                        // async def, def, class
                        { regex: /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/ },
                    ];
                    break;
                case ".go":
                    patterns = [
                        // func Name, func (r Receiver) Name
                        { regex: /^\s*func\s+(?:\[[^\]]+\]\s+)?(?:\([^)]+\)\s+)?(\w+)/ },
                        // type Name struct/interface
                        { regex: /^\s*type\s+(\w+)/ },
                    ];
                    break;
                case ".rs":
                    patterns = [
                        // pub async fn, struct, enum, trait, type
                        { regex: /^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+(\w+)/ },
                    ];
                    break;
                case ".java":
                case ".cs":
                    patterns = [
                        // public static final class/interface/enum/record
                        { regex: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+|sealed\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/ },
                    ];
                    break;
                default:
                    // 默认 TS/JS 匹配规则
                    patterns = [
                        // export (default)? (abstract)? class/interface/enum 名称
                        { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum)\s+(\w+)/ },
                        // export (default)? type 名称 = ...
                        { regex: /^\s*(?:export\s+)?(?:default\s+)?type\s+(\w+)\s*[=<]/ },
                        // export (default)? (async)? function 名称
                        { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/ },
                        // export const/let/var 名称 = (async)? (...) =>  箭头函数
                        { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/ },
                        // export const/let/var 名称 = function  函数表达式
                        { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/ },
                    ];
                    break;
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]!;
                const trimmed = line.trim();

                // 跳过纯注释和空行（简单兼容多语言的注释风格）
                if (
                    !trimmed || 
                    trimmed.startsWith("//") || 
                    trimmed.startsWith("/*") || 
                    trimmed.startsWith("*") || 
                    trimmed.startsWith("#")
                ) {
                    continue;
                }

                for (const { regex } of patterns) {
                    const match = trimmed.match(regex);
                    if (match) {
                        const lineNum = i + 1;
                        symbols.push({ line: lineNum, text: trimmed });
                        break; // 一行只匹配一个模式
                    }
                }
            }

            // ── 输出 ──────────────────────────────────────────

            if (symbols.length === 0) {
                return `[文件: ${filepath}]\n未匹配到明显的顶级符号（class/function/interface/type 等）。\n文件可能是纯数据、配置文件或仅有 import 语句。`;
            }

            let result = `[文件: ${filepath}]  符号数: ${symbols.length}\n`;
            result += `${"—".repeat(48)}\n`;
            for (const { line, text } of symbols) {
                // 长行截断保持可读性
                const display = text.length > 100 ? text.slice(0, 97) + "..." : text;
                result += `${String(line).padStart(4, " ")} │ ${display}\n`;
            }
            result += `${"—".repeat(48)}\n`;
            result += `提示: 使用 read_file_lines 传入对应行号查看具体实现。`;

            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `提取符号失败: ${msg}`;
        }
    }
}
