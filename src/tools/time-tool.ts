import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

/**
 * 测试用时间工具 —— 返回当前日期时间。
 * 支持可选参数 format（输出格式），演示多参数工具的定义方式。
 */
export class TimeTool extends BaseTool {
    name = "get_current_time";
    description = "获取当前日期和时间。可选参数 format 指定输出格式。";

    parameters: ToolParam[] = [
        {
            name: "format",
            type: "string",
            description: "时间输出格式：'full'（完整日期时间）、'date'（仅日期）、'time'（仅时间），默认为 'full'",
            enum: ["full", "date", "time"],
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const format = (args["format"] as string) || "full";
        const now = new Date();

        switch (format) {
            case "date":
                return `当前日期: ${now.toLocaleDateString("zh-CN")}`;
            case "time":
                return `当前时间: ${now.toLocaleTimeString("zh-CN")}`;
            default:
                return `当前日期时间: ${now.toLocaleString("zh-CN")}`;
        }
    }
}
