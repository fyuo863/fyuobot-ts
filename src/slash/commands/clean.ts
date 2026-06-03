// src/slash/commands/clean.ts
//
// /clean — 清空终端上的对话历史显示

import type { SlashCommand, CommandContext } from "../types.js";

export const cleanCommand: SlashCommand = {
    name: "clean",
    aliases: ["cls", "clear"],
    description: "清空屏幕上的对话历史",

    execute(ctx: CommandContext) {
        ctx.ui.clearHistory();
        return { type: "success" };
    },
};
