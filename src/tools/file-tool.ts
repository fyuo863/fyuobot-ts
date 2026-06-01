import * as fs from "fs/promises";
import * as path from "path";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

export class FileTool extends BaseTool {
    name = "file_operator";
    description = "读取或写入本地文件内容。可以用来查看代码、读取配置、或者将修改后的代码写回磁盘。";

    parameters: ToolParam[] = [
        {
            name: "action",
            type: "string",
            description: "要执行的操作：'read'（读取文件内容）或 'write'（覆盖写入文件内容）",
            required: true,
            enum: ["read", "write"] // 利用了你 BaseTool 中定义的 enum 特性
        },
        {
            name: "filePath",
            type: "string",
            description: "目标文件的路径（可以是相对路径或绝对路径）",
            required: true,
        },
        {
            name: "content",
            type: "string",
            description: "要写入的文件完整内容（仅当 action 为 'write' 时需要）",
            required: false,
        }
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const action = args["action"] as string;
        const filePath = args["filePath"] as string;
        const content = args["content"] as string | undefined;

        try {
            // 将路径统一转换为绝对路径，基于当前终端运行的目录 (process.cwd())
            const absolutePath = path.resolve(process.cwd(), filePath);

            if (action === "read") {
                // 尝试读取文件
                const data = await fs.readFile(absolutePath, "utf-8");
                return `文件 ${filePath} 读取成功:\n\n${data}`;
                
            } else if (action === "write") {
                if (content === undefined) {
                    return `文件操作失败: 当 action 为 'write' 时，必须提供 'content' 参数。`;
                }

                // 核心细节：如果目标文件所在的目录不存在，直接写入会报错。
                // 所以我们先用 mkdir(..., { recursive: true }) 确保父级目录树存在。
                await fs.mkdir(path.dirname(absolutePath), { recursive: true });
                
                // 覆盖写入文件
                await fs.writeFile(absolutePath, content, "utf-8");
                return `文件 ${filePath} 写入成功，已保存至本地磁盘。`;
                
            } else {
                return `文件操作失败: 未知的 action '${action}'`;
            }
        } catch (error: any) {
            // 详细的错误回传，例如 "ENOENT: no such file or directory" 
            // 能让大模型知道文件不存在，从而可能会先调用 shell 寻找文件
            return `文件操作失败!\n[ERROR]: ${error.message}`;
        }
    }
}