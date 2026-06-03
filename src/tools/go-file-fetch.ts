import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";
import { spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

export class GoFileFetchTool extends BaseTool {
    name = "go-file-fetch";
    description = "多线程并发文件下载器。当用户需要从指定的 URL 高速下载文件时，Agent 可以调用此工具。它支持断点续传，并实时输出下载进度。";

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
        },
        {
            // 💡 新增：目录参数
            name: "dir",
            type: "string",
            description: "下载保存的目标文件夹路径。如果不传，默认保存在当前工作目录。",
            required: false,
        },
    ];

    async execute(
        args: Record<string, unknown>,
        onProgress?: (chunk: string) => void,
    ): Promise<string> {
        const url = args["url"] as string;
        const threads = (args["threads"] as number) || 4;
        const dir = args["dir"] as string | undefined; // 💡 提取 dir 参数

        // 1. 自动适配操作系统类型
        const platform = os.platform();
        let binaryName = "";

        switch (platform) {
            case "win32":
                binaryName = "go-file-fetch.exe";
                break;
            case "linux":
            case "darwin":
                binaryName = "go-file-fetch";
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
        const execArgs = ["fetch", url, "-t", threads.toString()];
        let targetDirInfo = "当前工作目录";

        // 💡 如果 Agent 传入了目录参数，处理并追加到命令中
        if (dir) {
            // 将路径转换为绝对路径，避免相对路径带来的歧义
            const absoluteDir = path.resolve(process.cwd(), dir);
            execArgs.push("-d", absoluteDir);
            targetDirInfo = absoluteDir;
        }

        onProgress?.(`🚀 启动下载: ${url}`);
        onProgress?.(`📂 保存目录: ${targetDirInfo}`);
        onProgress?.(`⚙️ 线程数: ${threads} | 二进制: ${binaryName}`);

        // 4. spawn 子进程，实时流式读取 stdout/stderr
        return new Promise((resolve) => {
            const proc = spawn(binaryPath, execArgs, {
                stdio: ["ignore", "pipe", "pipe"],
            });

            let stdout = "";
            let stderr = "";
            let lastProgress = "";

            const emitLine = (line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                // 避免重复输出相同的进度行
                if (trimmed === lastProgress) return;
                lastProgress = trimmed;
                onProgress?.(trimmed);
            };

            proc.stdout?.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                // 按行拆分，逐行推送进度
                for (const line of text.split(/\r?\n/)) {
                    emitLine(line);
                }
            });

            proc.stderr?.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                stderr += text;
                for (const line of text.split(/\r?\n/)) {
                    emitLine(line);
                }
            });

            proc.on("close", (code) => {
                if (code === 0) {
                    const summary = stderr || stdout;
                    resolve(
                        `✅ 文件下载任务已完成。已保存至: ${targetDirInfo}\n` +
                        `输出日志:\n${summary.slice(-3000)}`,
                    );
                } else {
                    resolve(
                        `❌ 文件下载失败！\n` +
                        `退出码: ${code}\n` +
                        `程序日志: ${(stderr || stdout).slice(-2000) || "无"}`,
                    );
                }
            });

            proc.on("error", (err: NodeJS.ErrnoException) => {
                if (err.code === "EACCES") {
                    resolve(
                        `❌ 文件下载失败！\n` +
                        `错误: 缺少执行权限。\n` +
                        `请在终端执行 \`chmod +x ${binaryPath}\` 赋予二进制文件运行权限。`,
                    );
                } else {
                    resolve(`❌ 文件下载失败！\n错误: ${err.message}`);
                }
            });
        });
    }
}