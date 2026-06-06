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
               `提示：启动外部 .exe 时，由于路径可能含空格，建议使用: Start-Process -FilePath "路径"。\n` +
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
                // 强制采用 UTF-8 防止中文路径乱码，并转为 Base64
                const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
                const base64Cmd = Buffer.from(psCommand, "utf16le").toString("base64");
                
                // 放弃复杂的 spawn 管道管理，使用最稳定的 exec 字符串执行
                // 删除了 -WindowStyle Hidden，防止火绒再次拦截。Node.js 的 exec 默认自带隐藏窗口效果！
                const finalCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${base64Cmd}`;
                
                // 🌟 终极杀招：直接调用 exec，但不使用 await！
                // Node 会在后台安全地维护 IO 管道。PowerShell 执行完 Start-Process 唤起游戏后会自动退出。
                exec(finalCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error("\n[ShellTool Background Error] 后台进程启动失败:", error.message);
                        if (stderr) console.error("详细报错:", stderr);
                    }
                });
            } else {
                // Linux / macOS 维持原样
                const child = spawn("/bin/sh", ["-c", command], {
                    detached: true,
                    stdio: "ignore", 
                });
                child.on("error", (err) => console.error("\n[ShellTool Error] 后台进程启动失败:", err));
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