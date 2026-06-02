// src/agent/prompts.ts
//
// 提示词分层设计 —— 提高 LLM 提示缓存命中率
//
// 原理：LLM 的 prompt cache 以前缀匹配为键。
// 将不常变动的内容（工具描述、规则）放在消息数组最前面，
// agent 身份设定等相对易变的内容放在其后，
// 这样核心系统提示词跨请求保持缓存命中。
//
// 启动时自动读取 USER.md / MEMORY.md 并注入到初始消息中，
// 无需 agent 手动调用 memory read 工具。

import type OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

// ── 记忆文件读取 ──────────────────────────────────────────────

/** 记忆文件的基础目录 */
const MEMORIES_DIR = path.resolve(process.cwd(), ".fyuobot", "memories");

/**
 * 同步读取单个记忆文件。
 * 文件不存在或读取失败时返回空字符串。
 */
function readMemoryFile(filename: string): string {
    try {
        const content = fs.readFileSync(path.join(MEMORIES_DIR, filename), "utf-8").trim();
        return content;
    } catch {
        return "";
    }
}

/** 读取用户偏好文件（USER.md） */
export function loadUserPreferences(): string {
    return readMemoryFile("USER.md");
}

/** 读取系统设置文件（MEMORY.md） */
export function loadSystemSettings(): string {
    return readMemoryFile("MEMORY.md");
}

// ── Layer 1：核心系统提示词（不经常变动，放在最前面以命中缓存）─────

/**
 * 核心系统提示词 —— 包含工具描述、工作规则、行为约束。
 * 这部分内容跨 agent、跨会话基本不变，作为缓存前缀。
 */
export const CORE_SYSTEM_PROMPT = [
    "你的工具：",
    "- execute_bash: 执行终端命令（ls, npm, git, tsc 等）",
    "- file_operator: 读写本地文件",
    "- memory: 读写记忆文件 + 搜索 SQLite 历史归档（search/stats 操作）",
    "- compress: 触发 HISTORY.md → SQLite 归档管道",
    "",
    "记忆系统（双层架构）：",
    "📝 热缓冲区 — .fyuobot/memories/HISTORY.md",
    "  - 每轮对话自动全量追加记录",
    "  - 超过 20,000 字符自动触发归档",
    "  - 使用 memory append 追加对话摘要",
    "",
    "🗄️ 冷归档 — .fyuobot/history/conversations.db (SQLite)",
    "  - HISTORY.md 超阈值时自动：压缩 → 分类 → 汇总 → 精炼 → 存入",
    "  - 使用 memory search <关键词> 搜索历史",
    "  - 使用 memory stats 查看归档统计",
    "",
    "配置文件（启动时自动注入到系统提示词，无需手动读取）：",
    "- .fyuobot/memories/MEMORY.md — 系统设置（已注入）",
    "- .fyuobot/memories/USER.md — 用户偏好（已注入）",
    "- 偏好变更请使用 memory write 工具及时更新对应文件",
    "- 无需在对话开始时手动读取 USER.md/MEMORY.md——它们已经在你的系统提示词中",
    "",
    "工作方式：",
    "- 收到用户请求后，先理解需求，再动手",
    "- 修改文件前先读取原始内容",
    "- 每次工具调用后，根据结果决定下一步",
    "- 任务完成后简要说明你做了什么",
    "- 对话记录会自动写入 HISTORY.md，无需手动操作",
].join("\n");

// ── Layer 2：Agent 身份设定（按 agent 不同可能变化）─────────────

/**
 * 根据 agent 名称构建身份提示词。
 * 这部分内容与具体 agent 绑定，切换 agent 时才变化。
 */
export function buildAgentIdentity(name: string): string {
    return `${name} 是一个专业的编程助手，帮助用户编写、修改和理解代码。`;
}

// ── 消息构建辅助 ──────────────────────────────────────────────

/**
 * 按缓存优化顺序构建初始消息数组：
 *   1. 核心系统提示词（缓存前缀 —— 最稳定）
 *   2. 用户偏好 USER.md（启动时自动读取，较稳定）
 *   3. 系统设置 MEMORY.md（启动时自动读取，较稳定）
 *   4. Agent 身份（相对稳定，按 agent 变化）
 *   5. 用户查询（每次变化）
 *
 * @param identity  Agent 身份提示词
 * @param userQuery 用户输入
 * @returns         缓存优化后的消息数组
 */
export function buildCacheOptimizedMessages(
    identity: string,
    userQuery: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: CORE_SYSTEM_PROMPT },
    ];

    // Layer 2.5: 用户偏好（USER.md）
    const userPrefs = loadUserPreferences();
    if (userPrefs) {
        messages.push({ role: "system", content: `[用户偏好 — .fyuobot/memories/USER.md]\n${userPrefs}` });
    }

    // Layer 2.6: 系统设置（MEMORY.md）
    const sysSettings = loadSystemSettings();
    if (sysSettings) {
        messages.push({ role: "system", content: `[系统设置 — .fyuobot/memories/MEMORY.md]\n${sysSettings}` });
    }

    messages.push({ role: "system", content: identity });
    messages.push({ role: "user", content: userQuery });
    return messages;
}

/**
 * 构建初始对话消息（不含用户查询，用于 TUI 初始化）。
 * 后续用户查询会追加到该数组末尾。
 */
export function buildInitialMessages(
    identity: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: CORE_SYSTEM_PROMPT },
    ];

    // Layer 2.5: 用户偏好（USER.md）
    const userPrefs = loadUserPreferences();
    if (userPrefs) {
        messages.push({ role: "system", content: `[用户偏好 — .fyuobot/memories/USER.md]\n${userPrefs}` });
    }

    // Layer 2.6: 系统设置（MEMORY.md）
    const sysSettings = loadSystemSettings();
    if (sysSettings) {
        messages.push({ role: "system", content: `[系统设置 — .fyuobot/memories/MEMORY.md]\n${sysSettings}` });
    }

    messages.push({ role: "system", content: identity });
    return messages;
}
