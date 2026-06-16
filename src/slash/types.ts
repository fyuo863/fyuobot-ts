// src/slash/types.ts
//
// Slash command 系统的核心类型定义。
// 采用纯接口（而非抽象类），因为命令不需要 toOpenAI() 等复杂方法，
// 纯对象更轻量、更灵活。

/** 命令执行时的上下文，提供命令所需的 UI 操作能力 */
export interface CommandContext {
    /** 命令参数（去掉命令名后的部分），如 "/clean --force" → "--force" */
    args: string;
    /** 提供给命令的 UI 操作接口 */
    ui: CommandUI;
}

/** 命令可调用的 UI 操作 */
export interface CommandUI {
    /** 清空屏幕上的对话历史 */
    clearHistory: () => void;
    /** 在聊天区添加一条系统消息 */
    addSystemMessage: (msg: string) => void;
    /** 开始新对话（重置 LLM 上下文和 Token 统计） */
    newConversation: () => void;
    /** 请求关闭当前 fyuo 会话 */
    exitApp: (reason?: string) => void;
}

/** 命令执行结果 */
export type CommandResult =
    | { type: "success" }
    | { type: "error"; message: string }
    | { type: "output"; text: string };

/** 一个斜杠命令的定义 */
export interface SlashCommand {
    /** 命令名，如 "clean"（不含前缀 "/"） */
    name: string;
    /** 简短描述，显示在帮助和补全建议中 */
    description: string;
    /** 别名，如 ["cls", "clear"] */
    aliases?: string[];
    /** 执行命令 */
    execute(ctx: CommandContext): CommandResult | Promise<CommandResult>;
}
