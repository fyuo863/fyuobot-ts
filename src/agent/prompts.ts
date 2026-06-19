import type OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import {
    appendRuntimeLog,
    hashDebugValue,
    logPromptDebug,
} from "../config/app-config.js";
import { resolveProjectAgentPath } from "../config/agent-paths.js";
import {
    getDefaultModelId,
    getDefaultSubAgentModelId,
    getVisionFallbackModelId,
    getVisionSubAgentModelId,
    listConfiguredModels,
} from "../llm/model-registry.js";

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
    "- file_operator: read, write, append, insert, replace, and delete local files.",
    "- read_file_symbols / read_file_lines: inspect large files before editing them.",
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
    "Multimodal rules:",
    "- This agent can use a multimodal vision-capable model to understand user-provided images.",
    "- If the user uploads or pastes images, treat that as an explicit multimodal input source for the current turn.",
    "- When the task depends on image contents, prefer using `delegate_task` to create a vision-capable sub agent for image analysis, especially if the current main model is weaker at vision or does not support vision.",
    "- For delegated tasks, use the normal sub-agent model for text/code work, and use the configured vision sub-agent model for image-dependent work.",
    "- If the user provides a local image file path and asks you to inspect the image, first call `load_local_image` to load that file into the current turn's attachment context, then delegate image analysis to a vision-capable sub agent.",
    "- If `load_local_image` fails, then explain the failure clearly and ask the user to upload or paste the image instead.",
    "- When delegating image analysis, instruct the sub agent to focus on describing the image, OCR text, key signals, errors, UI state, and actionable conclusions for the main task.",
    "- Treat image understanding results returned by a vision sub agent as real available context for the current turn; do not say you cannot see the image when image context has been provided through the system.",
    "- If the current main model does not support vision, the system may automatically use a configured vision-capable fallback model for image understanding.",
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
    "- If unsure whether something belongs in USER.md or MEMORY.md, do not write memory yet; prefer leaving it in history.db until the rule or preference is clearly durable.",
    "- Never write transient task state, repo/skill names, implementation details, one-off debugging notes, temporary fixes, test runs, creation logs, publishing logs, or speculative inferences to USER.md.",
    "- Never write one-off execution logs to MEMORY.md: tool creation records, bug fix logs, test pass/fail notes, published content IDs, temporary workaround notes, or task-specific report paths belong in history.db, not MEMORY.md.",
    "- Write MEMORY.md only for durable settings that should still guide future turns without re-reading the original conversation.",
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

function formatCapabilityFlag(value: boolean | undefined): string {
    return value === true ? "yes" : "no";
}

function buildModelCapabilityMessage(): string {
    const configuredModels = listConfiguredModels();
    const defaultMainModel = getDefaultModelId();
    const defaultSubAgentModel = getDefaultSubAgentModelId() ?? defaultMainModel;
    const visionFallbackModel = getVisionFallbackModelId() ?? "未配置";
    const visionSubAgentModel = getVisionSubAgentModelId() ?? visionFallbackModel;

    const lines = [
        "[Model registry]",
        `- Default main model: ${defaultMainModel}`,
        `- Default sub-agent text model: ${defaultSubAgentModel}`,
        `- Vision fallback model: ${visionFallbackModel}`,
        `- Vision sub-agent model: ${visionSubAgentModel}`,
        "- Configured model capabilities:",
    ];

    for (const model of configuredModels) {
        lines.push(
            [
                `  - ${model.id} => ${model.model}`,
                `vision=${formatCapabilityFlag(model.capabilities?.vision)}`,
                `toolUse=${formatCapabilityFlag(model.capabilities?.toolUse)}`,
                `streaming=${formatCapabilityFlag(model.capabilities?.streaming)}`,
                model.description ? `description=${model.description}` : "",
            ]
                .filter(Boolean)
                .join(" | "),
        );
    }

    lines.push(
        "- Only models with vision=yes can directly understand image pixels.",
        `- In this project, ${defaultMainModel} should be treated as the normal text-first main model unless a different model is explicitly selected.`,
        `- In this project, ${visionSubAgentModel} should be treated as the preferred multimodal/vision model for image-dependent sub-agent work.`,
        "- If an image is relevant, do not guess which model can see it. Use the registry above.",
    );

    return lines.join("\n");
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
    messages.push({ role: "system", content: buildModelCapabilityMessage() });

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
