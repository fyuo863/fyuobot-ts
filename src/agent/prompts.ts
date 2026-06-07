import type OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

const MEMORIES_DIR = path.resolve(process.cwd(), ".fyuobot", "memories");

function readMemoryFile(filename: string): string {
    try {
        return fs.readFileSync(path.join(MEMORIES_DIR, filename), "utf-8").trim();
    } catch {
        return "";
    }
}

export function loadUserPreferences(): string {
    return readMemoryFile("USER.md");
}

export function loadSystemSettings(): string {
    return readMemoryFile("MEMORY.md");
}

export const CORE_SYSTEM_PROMPT = [
    "你的工具：",
    "- execute_bash: 执行终端命令（ls, npm, git, tsc 等）",
    "- file_operator: 读写本地文件",
    "- memory: 读写记忆文件 + 搜索 SQLite 历史归档（search/stats 操作）",
    "- compress: 触发 HISTORY.md -> SQLite 归档管道",
    "",
    "记忆系统（双层架构）：",
    "热缓冲区 - .fyuobot/memories/HISTORY.md",
    "  - 每轮对话自动全量追加记录",
    "  - 超过 20,000 字符自动触发归档",
    "  - 使用 memory append 追加对话摘要",
    "",
    "冷归档 - .fyuobot/history/conversations.db (SQLite)",
    "  - HISTORY.md 超阈值时自动：压缩 -> 分类 -> 汇总 -> 精炼 -> 存入",
    "  - 使用 memory search <关键词> 搜索历史",
    "  - 使用 memory stats 查看归档统计",
    "",
    "配置文件（启动时自动注入到系统提示词，无需手动读取）：",
    "- .fyuobot/memories/MEMORY.md - 系统设置（已注入）",
    "- .fyuobot/memories/USER.md - 用户偏好（已注入）",
    "- 偏好变更请使用 memory write 工具及时更新对应文件",
    "- 无需在对话开始时手动读取 USER.md/MEMORY.md，它们已经在系统提示词中",
    "",
    "工作方式：",
    "- 收到用户请求后，先理解需求，再动手",
    "- 修改文件前先读取原始内容",
    "- 每次工具调用后，根据结果决定下一步",
    "- 任务完成后简要说明你做了什么",
    "- 对话记录会自动写入 HISTORY.md，无需手动操作",
].join("\n");

export interface PromptBuildOptions {
    identity?: string | undefined;
    systemPrompt?: string | undefined;
    extraSystemMessages?: string[] | undefined;
    userQuery?: string | undefined;
    includeUserPreferences?: boolean | undefined;
    includeSystemSettings?: boolean | undefined;
}

export function buildAgentIdentity(name: string): string {
    return `${name} 是一个专业的编程助手，帮助用户编写、修改和理解代码。`;
}

export function buildOrderedPromptMessages(
    options: PromptBuildOptions,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    const {
        identity,
        systemPrompt = CORE_SYSTEM_PROMPT,
        extraSystemMessages = [],
        userQuery,
        includeUserPreferences = true,
        includeSystemSettings = true,
    } = options;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (identity) {
        messages.push({ role: "system", content: identity });
    }

    if (includeUserPreferences) {
        const userPrefs = loadUserPreferences();
        if (userPrefs) {
            messages.push({
                role: "system",
                content: `[用户偏好 - .fyuobot/memories/USER.md]\n${userPrefs}`,
            });
        }
    }

    if (includeSystemSettings) {
        const sysSettings = loadSystemSettings();
        if (sysSettings) {
            messages.push({
                role: "system",
                content: `[系统设置 - .fyuobot/memories/MEMORY.md]\n${sysSettings}`,
            });
        }
    }

    messages.push({ role: "system", content: systemPrompt });

    for (const extraMessage of extraSystemMessages) {
        if (extraMessage.trim()) {
            messages.push({ role: "system", content: extraMessage });
        }
    }

    if (userQuery !== undefined) {
        messages.push({ role: "user", content: userQuery });
    }

    return messages;
}

export function buildCacheOptimizedMessages(
    identity: string,
    userQuery: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    return buildOrderedPromptMessages({
        identity,
        userQuery,
    });
}

export function buildInitialMessages(
    identity: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    return buildOrderedPromptMessages({
        identity,
    });
}
