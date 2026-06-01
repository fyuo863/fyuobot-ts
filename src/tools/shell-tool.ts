import { exec } from "child_process";
import { promisify } from "util";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

// 将回调形式的 exec 转换为 Promise 形式，方便使用 async/await
const execAsync = promisify(exec);

export class ShellTool extends BaseTool {
    name = "execute_bash";
    description = "在宿主机终端执行 Bash/Shell 命令。可以用于读取目录结构、执行脚本、安装依赖等操作。";

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
        
        try {
            // 设定 timeout（例如 15 秒），防止大模型执行了类似 'top' 或需要交互输入的阻塞式命令导致 Agent 卡死
            const { stdout, stderr } = await execAsync(command, { timeout: 15000 });
            
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