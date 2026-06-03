// src/slash/commands/new.ts
//
// /new — 开始新对话：清屏 + 重置 LLM 上下文 + 归零 Token 统计

import type { SlashCommand, CommandContext } from "../types.js";

export const newCommand: SlashCommand = {
    name: "new",
    description: "开始新对话（清屏并重置 LLM 上下文）",

    execute(ctx: CommandContext) {
        ctx.ui.clearHistory();
        ctx.ui.newConversation();
        ctx.ui.addSystemMessage("✅ 已开始新对话，上下文和 Token 统计已重置");
        return { type: "success" };
    },
};
