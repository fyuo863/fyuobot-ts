// src/tools/file/read-lines-tool.ts
//
// ReadLinesTool — 按行号范围读取文件内容，带行号标注输出。
// 与 ReadSymbolsTool 配合使用：先用 read_file_symbols 了解文件结构，
// 再用本工具按行号精准读取目标区域。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BaseTool, type ToolParam } from "../basetool.js";

export class ReadLinesTool extends BaseTool {
    name = "read_file_lines";
    description =
        "按行号范围读取文件内容，返回带行号标注的代码。适用于精准查看大文件中特定区域。建议先用 read_file_symbols 了解文件结构，再用本工具按行号查看具体实现。";
    parameters: ToolParam[] = [
        {
            name: "filepath",
            type: "string",
            description: "文件路径（相对或绝对）",
            required: true,
        },
        {
            name: "start_line",
            type: "number",
            description: "起始行号（从 1 开始）",
            required: true,
        },
        {
            name: "end_line",
            type: "number",
            description: "结束行号（含）",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const filepath = String(args.filepath ?? "");
        const start = Math.max(1, Number(args.start_line ?? 1));
        const end = Math.max(start, Number(args.end_line ?? start));

        if (!filepath) return "错误：缺少 filepath 参数。";

        try {
            const absolutePath = resolve(process.cwd(), filepath);
            const content = await readFile(absolutePath, "utf-8");
            const lines = content.split("\n");
            const totalLines = lines.length;

            if (start > totalLines) {
                return `错误：起始行 ${start} 超出文件总行数（${totalLines} 行）。`;
            }

            const targetLines = lines.slice(start - 1, end);
            const actualEnd = Math.min(end, totalLines);

            // 组装带行号的输出
            let result = `[文件: ${filepath}]  总行数: ${totalLines}  范围: ${start}-${actualEnd}\n`;
            result += `${"—".repeat(48)}\n`;

            for (let i = 0; i < targetLines.length; i++) {
                const lineNum = start + i;
                result += `${String(lineNum).padStart(4, " ")} │ ${targetLines[i]}\n`;
            }

            if (end > totalLines) {
                result += `\n⚠ 请求的结束行 ${end} 超出文件末尾（${totalLines} 行），已截断。\n`;
            }

            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `读取文件失败: ${msg}`;
        }
    }
}
