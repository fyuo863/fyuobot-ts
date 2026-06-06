import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

const execAsync = promisify(exec);

export class ShellTool extends BaseTool {
    name = "execute_command";
    
    // 动态提示词：让大模型知道如何正确启动 Windows 程序
    get description() {
        const isWin = os.platform() === "win32";
        const shellName = isWin ? "Windows PowerShell" : "Bash/Shell";
        return `在宿主机终端执行 ${shellName} 命令。\n` +
               `【极其重要】当前系统为 ${isWin ? "Windows" : "Unix/Linux"}，请严格使用 ${shellName} 语法。\n` +
               `提示：启动外部 .exe 时，由于路径可能含空格，建议使用: Start-Process -FilePath "路径" -WorkingDirectory "目录"。\n` +
               `对于启动 GUI 程序、长期挂起任务，必须设置 ignore=true 避免阻塞。`;
    }

    readonly dangerous = true;

    parameters: ToolParam[] = [
        {
            name: "command",
            type: "string",
            description: "需要执行的终端命令",
            required: true,
        },
        {
            name: "ignore",
            type: "boolean",
            description: "设为 true 可将任务放入后台非阻塞运行（如启动 GUI 游戏），不等待结果回传。",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const command = args["command"] as string;
        const ignore = args["ignore"] === true;
        const isWindows = os.platform() === "win32";

        if (ignore) {
            if (isWindows) {
                // 🌟 终极解法：将命令转为 UTF-16LE 编码的 Base64 字符串
                // 这样能 100% 免疫 PowerShell 命令行传参时的引号剥离陷阱
                const base64Cmd = Buffer.from(command, "utf16le").toString("base64");
                
                const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", base64Cmd], {
                    detached: true,
                    stdio: "ignore",
                    //windowsHide: true, 
                });
                child.unref();
            } else {
                const child = spawn("/bin/sh", ["-c", command], {
                    detached: true,
                    stdio: "ignore",
                });
                child.unref();
            }
            return `命令已在后台启动（ignore=true，不等待结果）:\n> ${command}`;
        }

        try {
            let finalCommand: string;
            
            if (isWindows) {
                // 强制转为 UTF-8 输出，解决中文报错变乱码的问题
                const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
                const base64Cmd = Buffer.from(psCommand, "utf16le").toString("base64");
                // 这里利用 Node 默认的 exec 直接执行编码后的命令，最稳定
                finalCommand = `powershell.exe -NoProfile -EncodedCommand ${base64Cmd}`;
            } else {
                finalCommand = command;
            }

            const execEnv = isWindows
                ? { ...process.env, PYTHONIOENCODING: "utf-8" }
                : undefined;

            const { stdout, stderr } = await execAsync(finalCommand, {
                timeout: 15000,
                ...(execEnv ? { env: execEnv } : {}),
            });

            if (stderr) {
                return `命令执行成功，但伴随警告输出:\n[STDERR]:\n${stderr}\n[STDOUT]:\n${stdout || "无"}`;
            }

            return stdout || "命令执行成功，没有输出。";
        } catch (error: any) {
            return `命令执行失败!\n[ERROR]: ${error.message}\n[STDOUT]: ${error.stdout || "无"}\n[STDERR]: ${error.stderr || "无"}`;
        }
    }
}