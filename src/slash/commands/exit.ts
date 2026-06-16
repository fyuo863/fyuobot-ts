import type { CommandContext, SlashCommand } from "../types.js";

export const exitCommand: SlashCommand = {
    name: "exit",
    aliases: ["quit", "bye"],
    description: "关闭当前 fyuo 会话",

    execute(ctx: CommandContext) {
        ctx.ui.exitApp("slash command");
        return {
            type: "output",
            text: "正在关闭当前 fyuo 会话...",
        };
    },
};
