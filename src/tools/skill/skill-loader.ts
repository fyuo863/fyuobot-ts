// src/tools/skill/skill-loader.ts
//
// SkillLoader — 将 SKILL.md 文件动态转换为 Agent 可调用的工具。
//
// 技能（Skill）是 "操作手册" 式的知识模块：
//   每个技能 = 一个文件夹，内含 SKILL.md（YAML 前置元数据 + Markdown 正文）。
//   LLM 调用技能工具时，获得完整正文作为执行指令。
//
// 加载优先级：
//   1. src/tools/skill/builtin/  — 内置技能（随项目分发）
//   2. .fyuobot/skills/          — 项目本地外挂技能
//   3. ~/.fyuobot/skills/        — 用户全局外挂技能
//
// 同名技能：内置 > 项目本地 > 用户全局（先注册的优先）。

import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { BaseTool, type ToolParam } from "../basetool.js";

// ── 类型 ──────────────────────────────────────────────────────

/** SKILL.md 前置元数据 */
interface SkillFrontmatter {
    name: string;
    description: string;
    /** 设为 true 则不会注册为工具（仅作参考文档） */
    "disable-model-invocation"?: boolean;
}

/** 加载结果统计 */
export interface SkillLoadResult {
    /** 成功加载的技能名列表 */
    loaded: string[];
    /** 被 skip 的技能名及原因 */
    skipped: Array<{ name: string; reason: string }>;
}

// ── Skill 工具类 ──────────────────────────────────────────────

/**
 * SkillTool — 技能的知识激活工具。
 *
 * 无参数：LLM 只需按名称调用即可获得完整 SOP。
 * 返回 SKILL.md 正文内容，作为 LLM 执行任务的指令参考。
 */
class SkillTool extends BaseTool {
    name: string;
    description: string;
    parameters: ToolParam[] = [];

    private skillBody: string;

    constructor(skillName: string, description: string, body: string) {
        super();
        // 加前缀避免与系统工具重名
        this.name = `skill_${skillName}`;
        this.description = description;
        this.skillBody = body;
    }

    async execute(): Promise<string> {
        return [
            `以下是执行 [${this.name}] 技能的标准操作程序（SOP）和指南。`,
            `请仔细阅读并严格按照以下步骤使用其他工具完成任务：`,
            "",
            this.skillBody,
        ].join("\n");
    }
}

// ── 公共 API ──────────────────────────────────────────────────

/**
 * 从单个目录加载所有技能，返回 BaseTool 数组。
 *
 * 目录结构：
 *   skills/
 *   ├── my-skill/
 *   │   └── SKILL.md        ← YAML frontmatter { name, description } + Markdown body
 *   └── another-skill/
 *       └── SKILL.md
 *
 * @param dirPath     技能目录的文件系统路径
 * @param logPrefix   日志前缀（用于区分内置/外挂来源）
 */
export async function loadSkillsFromDirectory(
    dirPath: string,
    logPrefix = "[skills]",
): Promise<BaseTool[]> {
    const tools: BaseTool[] = [];

    if (!existsSync(dirPath)) return tools;

    let entries: Dirent[];
    try {
        entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
        console.warn(`${logPrefix} 无法读取目录: ${dirPath}`);
        return tools;
    }

    // 按字母排序保证确定性加载
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        // 跳过禁用/隐藏/非目录
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

        const skillMdPath = join(dirPath, entry.name, "SKILL.md");

        let raw: string;
        try {
            raw = readFileSync(skillMdPath, "utf-8");
        } catch {
            // 目录下没有 SKILL.md，跳过
            continue;
        }

        let frontmatter: SkillFrontmatter;
        let body: string;
        try {
            const parsed = matter(raw);
            frontmatter = parsed.data as SkillFrontmatter;
            body = parsed.content;
        } catch (e) {
            console.warn(
                `${logPrefix} 解析 SKILL.md 失败: ${entry.name} —`,
                e instanceof Error ? e.message : String(e),
            );
            continue;
        }

        // 校验必填字段
        if (!frontmatter.name || !frontmatter.description) {
            console.warn(
                `${logPrefix} 跳过 ${entry.name}: SKILL.md 缺少 name 或 description`,
            );
            continue;
        }

        // 检查显式禁用标记
        if (frontmatter["disable-model-invocation"] === true) {
            continue;
        }

        const tool = new SkillTool(frontmatter.name, frontmatter.description, body);
        tools.push(tool);
    }

    return tools;
}

/**
 * 从多个目录加载技能，合并为 BaseTool 数组。
 *
 * 同名技能（以 skill_xxx 工具名计）遵循先注册优先原则：
 * 数组前面的目录优先级更高。
 *
 * @param dirs  按优先级排列的技能目录路径列表
 */
export async function loadSkillsFromDirectories(
    dirs: string[],
): Promise<SkillLoadResult> {
    const result: SkillLoadResult = { loaded: [], skipped: [] };
    const seen = new Set<string>();

    for (const dir of dirs) {
        // 为每个来源使用不同的日志前缀
        const isBuiltin = dir.includes("builtin");
        const prefix = isBuiltin ? "[skills:内置]" : "[skills:外挂]";

        const tools = await loadSkillsFromDirectory(dir, prefix);

        for (const tool of tools) {
            if (seen.has(tool.name)) {
                result.skipped.push({
                    name: tool.name,
                    reason: "与更高优先级的技能同名，已跳过",
                });
                continue;
            }
            seen.add(tool.name);
            result.loaded.push(tool.name);
        }
    }

    return result;
}

/**
 * 将技能工具注册到 ToolRegistry。
 * 同名工具不覆盖（内置优先）。
 *
 * @returns 成功注册的数量
 */
export function registerSkillsToRegistry(
    registry: import("../basetool.js").ToolRegistry,
    tools: BaseTool[],
): number {
    let count = 0;
    for (const tool of tools) {
        try {
            registry.register(tool);
            count++;
        } catch {
            // 同名工具已存在（内置优先），静默跳过
        }
    }
    return count;
}
