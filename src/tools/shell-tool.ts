import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os"; // 🌟 新增：引入 Node.js 原生的 os 模块
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

// 将回调形式的 exec 转换为 Promise 形式，方便使用 async/await
const execAsync = promisify(exec);

export class ShellTool extends BaseTool {
    name = "execute_bash";
    description = "在宿主机终端执行 Bash/Shell 命令。可以用于读取目录结构、执行脚本、安装依赖等操作。";
    readonly dangerous = true;

    parameters: ToolParam[] = [
        {
            name: "command",
            type: "string",
            description: "需要执行的终端命令，例如：'ls -la', 'pwd', 'npm run test'",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const command = args["command"] as string;

        // 🌟 Windows 编码修复：
        //   1. chcp 65001 切换 CMD 代码页为 UTF-8
        //   2. PYTHONIOENCODING=utf-8 强制 Python 使用 UTF-8 输出（修复中文乱码）
        const isWindows = os.platform() === 'win32';
        const finalCommand = isWindows ? `chcp 65001 >nul & ${command}` : command;
        const execEnv = isWindows
            ? { ...process.env, PYTHONIOENCODING: 'utf-8' }
            : undefined;

        try {
            // 使用处理过后的 finalCommand
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