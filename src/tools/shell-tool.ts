import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as os from "os"; // 🌟 新增：引入 Node.js 原生的 os 模块
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

// 将回调形式的 exec 转换为 Promise 形式，方便使用 async/await
const execAsync = promisify(exec);

export class ShellTool extends BaseTool {
    name = "execute_bash";
    description =
        "在宿主机终端执行 Bash/Shell 命令。可以用于读取目录结构、执行脚本、安装依赖等操作。" +
        "对于启动 GUI 程序（如 .exe）、打开文件、启动长时间服务、下载文件等不需要等待回传的操作，" +
        "应将 ignore 设为 true 以避免阻塞。";
    readonly dangerous = true;

    parameters: ToolParam[] = [
        {
            name: "command",
            type: "string",
            description: "需要执行的终端命令，例如：'ls -la', 'pwd', 'npm run test'",
            required: true,
        },
        {
            name: "ignore",
            type: "boolean",
            description:
                "是否忽略回传结果（不等待命令执行完毕）。" +
                "适用于启动 .exe / GUI 程序、下载文件、打开浏览器等耗时或常驻操作。" +
                "设为 true 时命令在后台非阻塞执行；默认 false（等待命令完成并返回输出）。",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const command = args["command"] as string;
        const ignore = args["ignore"] === true;

        // 🌟 Windows 编码修复：
        //   1. chcp 65001 切换 CMD 代码页为 UTF-8
        //   2. PYTHONIOENCODING=utf-8 强制 Python 使用 UTF-8 输出（修复中文乱码）
        const isWindows = os.platform() === "win32";
        const finalCommand = isWindows ? `chcp 65001 >nul & ${command}` : command;
        const execEnv = isWindows
            ? { ...process.env, PYTHONIOENCODING: "utf-8" }
            : undefined;

        // ── ignore 模式：后台启动，立即返回 ──
        if (ignore) {
            const child = spawn(finalCommand, {
                shell: true,
                detached: true,
                stdio: "ignore",
                ...(execEnv ? { env: execEnv } : {}),
            });
            child.unref(); // 允许父进程独立退出
            return `命令已在后台启动（ignore=true，不等待结果）:\n> ${command}`;
        }

        // ── 正常模式：等待命令执行完毕 ──
        try {
            const { stdout, stderr } = await execAsync(finalCommand, {
                timeout: 15000,
                ...(execEnv ? { env: execEnv } : {}),
            });

            // 很多 CLI 工具（比如 npm）即使执行成功，也会把警告信息写进 stderr
            if (stderr) {
                return `命令执行成功，但伴随警告输出:\n[STDERR]:\n${stderr}\n[STDOUT]:\n${stdout || "无"}`;
            }

            return stdout || "命令执行成功，没有返回任何文本输出。";
        } catch (error: any) {
            // 当命令退出码不为 0 时（执行报错），必须把完整的错误信息喂回给大模型
            // 这样大模型才能看到报错日志，并尝试修改命令再次执行
            return `命令执行失败!\n[ERROR]: ${error.message}\n[STDOUT]: ${error.stdout || "无"}\n[STDERR]: ${error.stderr || "无"}`;
        }
    }
}