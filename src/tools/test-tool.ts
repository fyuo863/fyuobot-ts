import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

/**
 * 测试用时间工具 —— 返回当前日期时间。
 * 支持可选参数 format（输出格式），演示多参数工具的定义方式。
 */
export class TimeTool extends BaseTool {
    name = "test-tool";
    description = "进行工具测试。传入字符串，输出相同字符串";

    parameters: ToolParam[] = [
        {
            name: "input",
            type: "string",
            description: "要测试的输入字符串",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const input = args["input"] as string;
        return `测试结果: ${input}`;
    }
}

