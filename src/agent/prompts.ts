// src/agent/prompts.ts
//
// 提示词分层设计 —— 提高 LLM 提示缓存命中率
//
// 原理：LLM 的 prompt cache 以前缀匹配为键。
// 将不常变动的内容（工具描述、规则）放在消息数组最前面，
// agent 身份设定等相对易变的内容放在其后，
// 这样核心系统提示词跨请求保持缓存命中。

import type OpenAI from "openai";

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
    "配置文件：",
    "- .fyuobot/memories/MEMORY.md — 系统设置",
    "- .fyuobot/memories/USER.md — 用户偏好",
    "- 每次对话开始时读取 USER.md，偏好变更及时更新",
    "",
    "工作方式：",
    "- 收到用户请求后，先理解需求，再动手",
    "- 修改文件前先读取原始内容",
    "- 每次工具调用后，根据结果决定下一步",
    "- 任务完成后简要说明你做了什么",
    "- 对话结束后，用 memory append 将摘要写入 HISTORY.md",
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
 *   2. Agent 身份（相对稳定，按 agent 变化）
 *   3. 用户查询（每次变化）
 *
 * @param identity  Agent 身份提示词
 * @param userQuery 用户输入
 * @returns         缓存优化后的消息数组
 */
export function buildCacheOptimizedMessages(
    identity: string,
    userQuery: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    return [
        { role: "system", content: CORE_SYSTEM_PROMPT },
        { role: "system", content: identity },
        { role: "user", content: userQuery },
    ];
}

/**
 * 构建初始对话消息（不含用户查询，用于 TUI 初始化）。
 * 后续用户查询会追加到该数组末尾。
 */
export function buildInitialMessages(
    identity: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    return [
        { role: "system", content: CORE_SYSTEM_PROMPT },
        { role: "system", content: identity },
    ];
}
