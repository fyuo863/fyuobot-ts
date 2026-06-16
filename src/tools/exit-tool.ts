import { BaseTool, type ToolParam } from "./basetool.js";

export class ExitTool extends BaseTool {
    name = "exit_app";
    description =
        "请求在当前任务结束后关闭 fyuo 主会话。适用于让 Agent 在完成工作后自行退出。";

    parameters: ToolParam[] = [
        {
            name: "reason",
            type: "string",
            description: "可选：关闭原因，会写入日志。",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const reason =
            typeof args["reason"] === "string" && args["reason"].trim()
                ? args["reason"].trim()
                : "tool request";
        (
            globalThis as {
                __FYUO_REQUEST_EXIT__?: (reason?: string) => void;
            }
        ).__FYUO_REQUEST_EXIT__?.(reason);
        return `已请求在当前任务完成后关闭 fyuo 会话。reason=${reason}`;
    }
}
