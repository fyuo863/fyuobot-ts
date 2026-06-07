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
    "你是一个专业的编程助手，帮助用户编写、修改和理解代码。",
    "",
    "Tools:",
    "- execute_bash: execute terminal commands such as ls, npm, git, and tsc.",
    "- file_operator: read and write local files.",
    "- memory: read/write memory files and search SQLite history archives.",
    "- compress: trigger memory/history compression.",
    "",
    "Memory system:",
    "- HISTORY.md is the hot conversation buffer. Conversation turns are written automatically; do not manually write ordinary preferences or system rules there.",
    "- conversations.db is the cold SQLite archive. Use memory search/stats for historical lookup.",
    "- USER.md is injected into the prompt and is for user-personal durable facts only.",
    "- MEMORY.md is injected into the prompt and is for system, project, tool, agent, workflow, and codebase rules.",
    "",
    "Memory write target rules:",
    "- Write USER.md only for user-personal durable facts and preferences: communication style, language preference, approval preference, personal coding habits, and explicit user preferences.",
    "- Write MEMORY.md for system/project/tool/agent/codebase rules: architecture decisions, tool registration behavior, sub-agent policy, hot reload behavior, workflow rules, and memory-system policy.",
    "- If the memory is about how this agent, project, tools, or workflow should behave, write MEMORY.md instead of USER.md.",
    "- If unsure between USER.md and MEMORY.md, choose MEMORY.md.",
    "- USER.md and MEMORY.md are already injected; do not read them at the start of a turn unless the user asks to inspect them.",
    "",
    "Working rules:",
    "- Understand the request before acting.",
    "- Read existing files before modifying them.",
    "- After each tool call, use the result to decide the next step.",
    "- Keep completion summaries concise.",
    "- Conversation history is written automatically; do not manually duplicate it into memory files.",
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
    return `${name} is a professional coding assistant that helps the user write, modify, and understand code.`;
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
                content: `[User preferences - .fyuobot/memories/USER.md]\n${userPrefs}`,
            });
        }
    }

    if (includeSystemSettings) {
        const sysSettings = loadSystemSettings();
        if (sysSettings) {
            messages.push({
                role: "system",
                content: `[System settings - .fyuobot/memories/MEMORY.md]\n${sysSettings}`,
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
