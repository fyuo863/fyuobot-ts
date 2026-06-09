import type { Agent } from "../agent/agent.js";
import { BaseTool, type ToolParam } from "./basetool.js";
import { triggerToolHotReload } from "./tool-hot-reload.js";

export class HotReloadTriggerTool extends BaseTool {
    name = "trigger_hot_reload";
    description =
        "主动触发工具热重载构建。用于在 agent 修改 .fyuobot/tools、skills 或工具 schema 后，不等待文件监听，直接准备下一轮生效的工具注册表。";

    parameters: ToolParam[] = [
        {
            name: "reason",
            type: "string",
            description: "可选：本次热重载触发原因，会记录到日志中。",
            required: false,
        },
    ];

    private agentRef: Agent | undefined;

    onInit(agent: Agent): void {
        this.agentRef = agent;
    }

    async execute(args: Record<string, unknown>): Promise<string> {
        if (!this.agentRef) {
            return "❌ 热重载工具尚未完成初始化。";
        }

        const reason =
            typeof args["reason"] === "string" && args["reason"].trim()
                ? args["reason"].trim()
                : "trigger_hot_reload tool";

        const result = await triggerToolHotReload(
            { agent: this.agentRef },
            reason,
        );

        return result.changed
            ? `♻️ ${result.message}`
            : `ℹ️ ${result.message}`;
    }
}
