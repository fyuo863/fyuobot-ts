import type OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import {
    appendRuntimeLog,
    hashDebugValue,
    logPromptDebug,
} from "../config/app-config.js";
import { resolveProjectAgentPath } from "../config/agent-paths.js";

function readMemoryFile(filename: string): string {
    try {
        const memoriesDir = resolveProjectAgentPath("memories");
        return fs.readFileSync(path.join(memoriesDir, filename), "utf-8").trim();
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
    "你是一个类似于贾维斯的计算机助手，辅助用户进行各种操作。",
    "",
    "Tools:",
    "- execute_command: execute terminal commands such as ls, npm, git, and tsc.",
    "- file_operator: read and write local files.",
    "- memory: read/write memory files and search SQLite history archives.",
    "- compress: trigger memory/history compression.",
    "",
    "Memory system:",
    "- history.db is the automatic episodic memory store. It records each turn with date, 24-hour time, the user's initial prompt, called tools, and the final agent reply.",
    "- A turn ends when the agent finishes its output and control returns to the user for the next input.",
    "- Use memory(file=\"history\", action=\"day\", content=\"YYYY-MM-DD\") when the user asks what happened on a specific day.",
    "- Use memory(file=\"history\", action=\"recent\") for the previous turn, just now, or latest conversation context.",
    "- Use memory(file=\"history\", action=\"search\", content=\"...\") for keyword lookup across recorded turns.",
    "- USER.md is injected into the prompt and is for user-personal durable facts only.",
    "- MEMORY.md is injected into the prompt and is for system, project, tool, agent, workflow, and codebase rules.",
    "- Do not manually write ordinary conversation logs into USER.md or MEMORY.md.",
    "",
    "Memory write target rules:",
    "- Decide yourself whether something deserves USER.md. Do not rely on keyword matching.",
    "- USER.md and MEMORY.md use the same enforced markdown structure: one H1 title, then H2 sections, then bullet entries.",
    "- If you write USER.md, choose the section yourself: [Current Preferences], [Environment], [Projects], or [Historical Notes].",
    "- If you write MEMORY.md, choose the section yourself: [Agent Rules], [Project Rules], [Tooling], or [Historical Notes].",
    "- The only supported entry format is: - [YYYY/M/D] [Section Name] content",
    "- Write USER.md only for durable user facts: communication style, language preference, approval preference, coding/comment habits, stable OS/shell/path preferences, explicit long-term personal taste preferences, stable app/device preferences, routine/reminder habits, and frequently used websites or services.",
    "- Write MEMORY.md for system/project/tool/agent/codebase rules: architecture decisions, tool registration behavior, sub-agent policy, hot reload behavior, workflow rules, and memory-system policy.",
    "- If the memory is about how this agent, project, tools, or workflow should behave, write MEMORY.md instead of USER.md.",
    "- If unsure between USER.md and MEMORY.md, choose MEMORY.md.",
    "- Never write transient task state, repo/skill names, implementation details, one-off debugging notes, or speculative inferences to USER.md.",
    "- USER.md and MEMORY.md are already injected; do not read them at the start of a turn unless the user asks to inspect them.",
    "- history.db is written by the program, not by the agent. Do not append to history manually.",
    "",
    "Working rules:",
    "- Understand the request before acting.",
    "- Read existing files before modifying them.",
    "- After each tool call, use the result to decide the next step.",
    "- Keep completion summaries concise.",
    "- Conversation history is written automatically into history.db; do not manually duplicate it into memory files.",
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

    logPromptDebug("buildOrderedPromptMessages", {
        messageCount: messages.length,
        roleOrder: messages.map((message) => message.role),
        identityIncluded: Boolean(identity),
        includeUserPreferences,
        includeSystemSettings,
        extraSystemMessagesCount: extraSystemMessages.filter((message) =>
            message.trim(),
        ).length,
        userQueryLength: userQuery?.length ?? 0,
        messageHash: hashDebugValue(messages),
        userPreferencesHash: includeUserPreferences
            ? hashDebugValue(loadUserPreferences())
            : undefined,
        systemSettingsHash: includeSystemSettings
            ? hashDebugValue(loadSystemSettings())
            : undefined,
        systemPromptHash: hashDebugValue(systemPrompt),
    });
    appendRuntimeLog("prompt.messages", {
        messageCount: messages.length,
        messageHash: hashDebugValue(messages),
        messages,
    });

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
