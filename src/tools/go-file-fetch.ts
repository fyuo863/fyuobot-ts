import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

export class GoFileFetchTool extends BaseTool {
    name = "go-file-fetch";
    description = "多线程并发文件下载器。当用户需要从指定的 URL 高速下载文件时，Agent 可以调用此工具。它支持断点续传。";

    parameters: ToolParam[] = [
        {
            name: "url",
            type: "string",
            description: "要下载的文件的完整 URL 地址",
            required: true,
        },
        {
            name: "threads",
            type: "number",
            description: "并发下载的线程数。如果不传，默认为 4。",
            required: false,
        }
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const url = args["url"] as string;
        const threads = (args["threads"] as number) || 4; 

        // 1. 自动适配操作系统类型
        const platform = os.platform();
        let binaryName = "";

        switch (platform) {
            case "win32":
                // 确保你的 bin 目录下 Windows 文件名与此一致
                binaryName = "go-file-fetch.exe"; 
                break;
            case "linux":
                // 确保你的 bin 目录下 Linux 文件名与此一致
                binaryName = "go-file-fetch"; 
                break;
            case "darwin":
                // 预留 macOS 支持
                binaryName = "go-file-fetch-mac";
                break;
            default:
                return `下载失败：当前 Agent 运行在不支持的操作系统 (${platform}) 上。`;
        }

        // 2. 构造绝对路径 —— 相对于本工具文件所在目录
        const binaryPath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            binaryName,
        ); 

        // 3. 构造命令行参数
        const execArgs = [
            "fetch", 
            url, 
            "-t", 
            threads.toString()
        ];

        try {
            // 4. 执行外部 Go 程序
            const { stdout, stderr } = await execFileAsync(binaryPath, execArgs, {
                // timeout: 600000, 
            });

            return `文件下载任务已完成。程序输出日志:\n${stderr || stdout}`;

        } catch (error: any) {
            // 💡 针对 Linux/Mac 的特殊错误拦截：权限不足
            if (error.code === 'EACCES') {
                return `文件下载失败！\n错误信息: 缺少执行权限。\n请在 Linux 终端执行 \`chmod +x ${binaryPath}\` 赋予二进制文件运行权限。`;
            }

            return `文件下载失败！\n错误信息: ${error.message}\n程序日志: ${error.stderr || '无'}`;
        }
    }
}