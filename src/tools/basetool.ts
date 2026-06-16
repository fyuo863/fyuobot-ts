import type OpenAI from "openai";
import { readdir } from "fs/promises";
import type { Dirent } from "fs";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { Agent } from "../agent/agent.js";
import { loadExternalToolRuntimeConfig } from "./external-tool-config.js";
import { isToolOutputEnabled } from "../config/app-config.js";

/**
 * 工具参数的 JSON Schema 定义。
 * 每个字段会映射到 OpenAI function calling 的 parameters.properties 中。
 */
export interface ToolParam {
    name: string;
    type: "string" | "number" | "boolean" | "array";
    description: string;
    required?: boolean;
    /** 当 type 为 "string" 时可选：限定枚举值 */
    enum?: string[];
    /** 当 type 为 "array" 时的元素类型，默认 "string" */
    itemsType?: string;
}

export interface ToolDiscoveryOptions {
    cacheBust?: string;
}

export interface ToolDiffLine {
    type: "context" | "add" | "remove";
    oldLineNumber: number | null;
    newLineNumber: number | null;
    text: string;
}

export interface ToolDiffHunk {
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: ToolDiffLine[];
}

export interface FileChangeArtifact {
    kind: "file_change";
    path: string;
    action: "write" | "append" | "insert" | "replace" | "delete";
    title: string;
    summary: string;
    unifiedDiff: string;
    addedLines: number;
    removedLines: number;
    hunks: ToolDiffHunk[];
}

export type ToolResultArtifact = FileChangeArtifact;

export interface ToolExecutionOutput {
    content: string;
    summary?: string;
    artifacts?: ToolResultArtifact[];
}

export type ToolExecutionResponse = string | ToolExecutionOutput;

export function normalizeToolExecutionResponse(
    output: ToolExecutionResponse,
): ToolExecutionOutput {
    if (typeof output === "string") {
        return { content: output };
    }
    return output;
}

/**
 * 工具基类 —— 所有具体工具继承此类并实现 execute()。
 * 每个工具自带 name / description / parameters，可调用 toOpenAI()
 * 直接生成 OpenAI function calling 格式。
 */
export abstract class BaseTool {
    abstract name: string;
    abstract description: string;
    abstract parameters: ToolParam[];

    /** 标记为敏感操作 —— 执行前需要用户在 TUI 中确认（Y/N） */
    readonly dangerous: boolean = false;

    /** Override when only some parameter combinations require confirmation. */
    requiresConfirmation?(args: Record<string, unknown>): boolean;

    /** 若为 true，工具输出正文默认不在 TUI/API 中展示。 */
    readonly hideOutput: boolean = false;

    /** 若为 true，强制显示工具输出，忽略全局 toolOutput.enabled 开关。 */
    readonly force: boolean = false;

    /**
     * 并发键 —— 具有相同 concurrencyKey 的工具在批处理执行中会被串行化。
     * 默认为工具名称，意味着同一工具类型的多次调用会自动排队。
     * 设置为 undefined 或唯一的键可允许与任何工具完全并行执行。
     */
    readonly concurrencyKey?: string = undefined;

    /**
     * 执行工具逻辑，由子类实现。
     *
     * @param args       工具参数
     * @param onProgress 可选 —— 流式进度回调。支持实时输出的工具（如下载器）会
     *                   逐行调用此回调；不支持的工具直接忽略。
     */
    abstract execute(
        args: Record<string, unknown>,
        onProgress?: (chunk: string) => void,
    ): Promise<ToolExecutionResponse>;

    // ── 生命周期钩子（可选覆盖）──────────────────────────

    /**
     * Agent 就绪后调用，工具可在此处启动伴随服务（如 HTTP API、WebSocket 等）。
     * 主体不关心是哪个工具实现了此钩子 —— 它只负责在合适的时机调用。
     *
     * @param agent  当前 Agent 实例，供工具持有的服务使用
     */
    onInit?(agent: Agent): void | Promise<void>;

    /**
     * 进程退出前调用，工具可在此处释放资源（关闭服务器、断开连接等）。
     */
    onDestroy?(): void | Promise<void>;

    /** 转为 OpenAI function calling 的 tool 定义 */
    toOpenAI(): OpenAI.Chat.Completions.ChatCompletionTool {
        const properties: Record<string, Record<string, unknown>> = {};
        const required: string[] = [];

        for (const p of this.parameters) {
            properties[p.name] = {
                type: p.type,
                description: p.description,
            };
            if (p.type === "array") {
                properties[p.name]!.items = { type: p.itemsType ?? "string" };
            }
            if (p.enum) {
                properties[p.name]!.enum = p.enum;
            }
            if (p.required) {
                required.push(p.name);
            }
        }

        return {
            type: "function",
            function: {
                name: sanitizeToolFunctionName(this.name),
                description: this.description,
                parameters: {
                    type: "object",
                    properties,
                    ...(required.length > 0 ? { required } : {}),
                },
            },
        };
    }
}

function sanitizeToolFunctionName(name: string): string {
    const normalized = name
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    if (normalized) {
        return normalized;
    }

    return "tool";
}

/**
 * 工具注册中心 —— 持有所有工具实例，按名称分发调用。
 */
export class ToolRegistry {
    private tools = new Map<string, BaseTool>();

    private resolveTool(name: string): BaseTool | undefined {
        const direct = this.tools.get(name);
        if (direct) return direct;

        for (const tool of this.tools.values()) {
            if (sanitizeToolFunctionName(tool.name) === name) {
                return tool;
            }
        }
        return undefined;
    }

    register(tool: BaseTool): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool "${tool.name}" is already registered.`);
        }
        this.tools.set(tool.name, tool);
    }

    /**
     * 自动扫描指定目录，动态导入所有工具模块，发现并注册 BaseTool 子类。
     * 新增工具只需在目录下放置一个继承 BaseTool 的文件即可生效。
     *
     * 扫描范围：
     *   - 目录下的扁平 .ts/.js 文件
     *   - 一层子目录（如 file/、web/ 等组织性子目录）内的 .ts/.js 文件
     *   - 以 `_` 或 `.` 开头的文件/子目录会被跳过
     *
     * 文件按名称字母顺序加载，确保跨平台/跨运行的注册顺序一致，
     * 防止因顺序差异导致 LLM prompt cache 失效。
     *
     * @param dirUrl  工具目录的 URL（通常传 `new URL("../tools", import.meta.url)`）
     */
    static async discoverAndRegister(
        dirUrl: URL,
        options: ToolDiscoveryOptions = {},
    ): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        const dirPath = fileURLToPath(dirUrl);

        let entries: Dirent[];
        try {
            entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
            console.warn(`⚠ 工具目录不存在: ${dirPath}`);
            return registry;
        }

        // 分离文件和子目录
        const files: Dirent[] = [];
        const subdirs: Dirent[] = [];
        for (const e of entries) {
            if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
            if (e.isDirectory()) {
                subdirs.push(e);
            } else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) {
                files.push(e);
            }
        }

        // 按字母顺序排序
        files.sort((a, b) => a.name.localeCompare(b.name));
        subdirs.sort((a, b) => a.name.localeCompare(b.name));

        // ── 加载扁平文件 ──
        for (const f of files) {
            if (f.name === "basetool.ts" || f.name === "basetool.js") continue;

            const filePath = join(dirPath, f.name);
            let fileUrl = pathToFileURL(filePath).href;
            if (options.cacheBust) {
                fileUrl += `?v=${encodeURIComponent(options.cacheBust)}`;
            }

            try {
                const mod = await import(fileUrl);
                for (const exported of Object.values(mod)) {
                    if (ToolRegistry.#isToolClass(exported)) {
                        const ToolClass = exported as new () => BaseTool;
                        registry.register(new ToolClass());
                    }
                }
            } catch (e) {
                console.warn(`⚠ 加载工具文件失败: ${f.name} — ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // ── 递归加载子目录内的 .ts/.js ──
        for (const sub of subdirs) {
            const subPath = join(dirPath, sub.name);
            let subEntries: Dirent[];
            try {
                subEntries = await readdir(subPath, { withFileTypes: true });
            } catch {
                continue;
            }
            subEntries.sort((a, b) => a.name.localeCompare(b.name));

            for (const se of subEntries) {
                if (!se.isFile()) continue;
                if (se.name.startsWith("_") || se.name.startsWith(".")) continue;
                if (!se.name.endsWith(".ts") && !se.name.endsWith(".js")) continue;

                const filePath = join(subPath, se.name);
                let fileUrl = pathToFileURL(filePath).href;
                if (options.cacheBust) {
                    fileUrl += `?v=${encodeURIComponent(options.cacheBust)}`;
                }

                try {
                    const mod = await import(fileUrl);
                    for (const exported of Object.values(mod)) {
                        if (ToolRegistry.#isToolClass(exported)) {
                            const ToolClass = exported as new () => BaseTool;
                            const tool = new ToolClass();
                            ToolRegistry.#applyExternalToolConfig(tool, filePath);
                            registry.register(tool);
                        }
                    }
                } catch (e) {
                    console.warn(
                        `⚠ 加载工具文件失败: ${sub.name}/${se.name} —`,
                        e instanceof Error ? e.message : String(e),
                    );
                }
            }
        }

        return registry;
    }

    /**
     * 文件夹模式扫描 —— 每个子目录代表一个工具，目录内可包含 .ts/.js 主文件
     * 及配套资源（二进制、配置等）。文件夹名不以 _ 或 . 开头才会被加载。
     *
     * 子目录按名称字母顺序扫描，目录内的文件也按名称排序，
     * 保证跨平台/跨运行的注册顺序一致。
     *
     * @param dirUrl  工具目录的 URL
     */
    static async discoverFromFolders(
        dirUrl: URL,
        options: ToolDiscoveryOptions = {},
    ): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        const dirPath = fileURLToPath(dirUrl);

        let entries: Dirent[];
        try {
            entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
            console.warn(`⚠ 工具目录不存在: ${dirPath}`);
            return registry;
        }

        // 按文件夹名称字母顺序排序，保证注册顺序确定性
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            // 只处理子目录，跳过 _ 和 . 开头的禁用/隐藏文件夹
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

            const toolDir = join(dirPath, entry.name);

            // 扫描子目录内的 .ts/.js 文件
            let files: string[];
            try {
                files = await readdir(toolDir);
            } catch {
                console.warn(`⚠ 无法读取工具文件夹: ${toolDir}`);
                continue;
            }
            files.sort((a, b) => a.localeCompare(b));

            for (const file of files) {
                if (file.startsWith("_") || file.startsWith(".")) continue;
                if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;

                const filePath = join(toolDir, file);
                let fileUrl = pathToFileURL(filePath).href;
                if (options.cacheBust) {
                    fileUrl += `?v=${encodeURIComponent(options.cacheBust)}`;
                }

                try {
                    const mod = await import(fileUrl);
                    for (const exported of Object.values(mod)) {
                        if (ToolRegistry.#isToolClass(exported)) {
                            const ToolClass = exported as new () => BaseTool;
                            const tool = new ToolClass();
                            ToolRegistry.#applyExternalToolConfig(tool, filePath);
                            registry.register(tool);
                        }
                    }
                } catch (e) {
                    console.warn(`⚠ 加载工具失败: ${entry.name}/${file} — ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }

        return registry;
    }

    /**
     * 扫描工具目录下每个子文件夹的 package.json，自动安装依赖。
     *
     * 所有外挂工具依赖都统一合并到项目根 package.json，
     * 再在项目根目录一次性 npm install。
     *
     * @param toolsDir    工具根目录的路径
     * @param projectRoot 项目根目录
     * @returns 处理了的工具数量（合并/安装了依赖的）
     */
    static async installDependencies(toolsDir: string, projectRoot?: string): Promise<number> {
        const execAsync = promisify(exec);

        let entries: Dirent[];
        try {
            entries = await readdir(toolsDir, { withFileTypes: true });
        } catch {
            console.warn(`⚠ 工具目录不存在: ${toolsDir}`);
            return 0;
        }

        // 收集每个工具的依赖
        const toolDeps: { name: string; deps: Record<string, string> }[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

            const pkgPath = join(toolsDir, entry.name, "package.json");
            if (!existsSync(pkgPath)) continue;

            try {
                const raw = readFileSync(pkgPath, "utf-8");
                const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
                if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
                    toolDeps.push({ name: entry.name, deps: pkg.dependencies });
                }
            } catch {
                console.warn(`⚠ [${entry.name}] 无法读取 package.json`);
            }
        }

        if (toolDeps.length === 0) return 0;

        if (!projectRoot) {
            console.warn(`⚠ 缺少 projectRoot，已跳过外挂工具依赖安装: ${toolsDir}`);
            return 0;
        }

        const rootPkgPath = join(projectRoot, "package.json");
        if (!existsSync(rootPkgPath)) {
            console.warn(`⚠ 找不到根 package.json: ${rootPkgPath}`);
            return 0;
        }

        const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8")) as {
            dependencies?: Record<string, string>;
        };
        rootPkg.dependencies ??= {};

        let added = 0;
        for (const { name, deps } of toolDeps) {
            for (const [pkgName, version] of Object.entries(deps)) {
                if (!(pkgName in rootPkg.dependencies)) {
                    rootPkg.dependencies[pkgName] = version;
                    console.log(`📦 [${name}] +${pkgName}@${version} → 根 package.json`);
                    added++;
                }
            }
        }

        if (added > 0) {
            writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
            console.log(`📦 正在根目录安装 ${added} 个新依赖...`);
            try {
                const { stdout, stderr } = await execAsync("npm install", { cwd: projectRoot });
                if (stdout) console.log(stdout);
                if (stderr) console.warn(stderr);
                console.log(`✅ 依赖安装完成`);
            } catch (e: any) {
                console.warn(`⚠ 依赖安装失败: ${e.message}`);
                if (e.stderr) console.warn(e.stderr);
            }
        } else {
            console.log(`✅ 所有工具依赖已存在于根 package.json，无需安装`);
        }

        return toolDeps.length;
    }

    /** 运行时检查一个值是否为 BaseTool 的构造函数（非抽象基类本身） */
    static #isToolClass(value: unknown): boolean {
        return (
            typeof value === "function" &&
            value !== BaseTool &&
            value.prototype instanceof BaseTool
        );
    }

    static #applyExternalToolConfig(tool: BaseTool, filePath: string): void {
        const config = loadExternalToolRuntimeConfig(dirname(filePath));
        if (config.hideOutput !== undefined) {
            Object.defineProperty(tool, "hideOutput", {
                value: config.hideOutput,
                configurable: true,
                enumerable: true,
                writable: true,
            });
        }
        if (config.force !== undefined) {
            Object.defineProperty(tool, "force", {
                value: config.force,
                configurable: true,
                enumerable: true,
                writable: true,
            });
        }
    }

    /** 生成所有已注册工具的 OpenAI tool 定义列表（按名称字母顺序，确保缓存确定性） */
    toOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return [...this.tools.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => t.toOpenAI());
    }

    /** 按名称获取工具实例（用于查询 dangerous 等元数据） */
    get(name: string): BaseTool | undefined {
        return this.resolveTool(name);
    }

    shouldHideOutput(name: string): boolean {
        const tool = this.resolveTool(name);
        if (!tool) return false;

        // 如果工具设置了 force，强制显示输出（返回 false 表示不隐藏）
        if (tool.force) return false;

        // 如果全局开关关闭，隐藏所有输出（除非 force = true）
        if (!isToolOutputEnabled()) return true;

        // 否则使用工具自身的 hideOutput 设置
        return tool.hideOutput;
    }

    /**
     * 按名称执行工具。
     *
     * @param onProgress 可选 —— 流式进度回调，透传给工具实例。
     */
    async execute(
        name: string,
        args: Record<string, unknown>,
        onProgress?: (chunk: string) => void,
    ): Promise<ToolExecutionResponse> {
        const tool = this.resolveTool(name);
        if (!tool) {
            return `Error: unknown tool "${name}"`;
        }
        try {
            return await tool.execute(args, onProgress);
        } catch (e) {
            return `Error executing "${name}": ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    /**
     * 将另一个 registry 中的所有工具合并到当前实例。
     * 同名工具以当前实例为准（不覆盖），返回成功合并的数量。
     */
    mergeFrom(other: ToolRegistry): number {
        let count = 0;
        for (const [name, tool] of other.tools) {
            if (!this.tools.has(name)) {
                this.tools.set(name, tool);
                count++;
            }
        }
        return count;
    }

    /**
     * 创建一个过滤后的 ToolRegistry 副本。
     *
     * - 如果 allowlist 为空 / undefined → 返回包含**所有**工具的副本
     * - 否则 → 只包含 allowlist 中指定名称的工具（不存在的工具名静默跳过）
     *
     * 用于子 Agent 场景：限制子 Agent 只能使用特定工具集。
     *
     * @param allowlist  允许的工具名列表（可选）
     * @returns          新的 ToolRegistry 实例
     */
    createFiltered(allowlist?: string[]): ToolRegistry {
        const filtered = new ToolRegistry();
        const allowed =
            allowlist && allowlist.length > 0
                ? new Set(allowlist)
                : null;
        for (const [name, tool] of this.tools) {
            if (!allowed || allowed.has(name)) {
                filtered.register(tool);
            }
        }
        return filtered;
    }

    // ── 生命周期 ──────────────────────────────────────────

    /**
     * 通知所有实现了 onInit 钩子的工具：Agent 已就绪。
     * 主体只负责调用此方法，不关心哪些工具响应。
     */
    async initAll(agent: Agent): Promise<void> {
        for (const tool of this.tools.values()) {
            if (tool.onInit) {
                try {
                    await tool.onInit(agent);
                } catch (e) {
                    console.warn(
                        `[lifecycle] ${tool.name}.onInit 失败: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
        }
    }

    /**
     * 通知所有实现了 onDestroy 钩子的工具：进程即将退出。
     * 主体只负责调用此方法，不关心哪些工具响应。
     */
    async destroyAll(): Promise<void> {
        for (const tool of this.tools.values()) {
            if (tool.onDestroy) {
                try {
                    await tool.onDestroy();
                } catch (e) {
                    console.warn(
                        `[lifecycle] ${tool.name}.onDestroy 失败: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
        }
    }

    names(): string[] {
        return [...this.tools.keys()];
    }

    get size(): number {
        return this.tools.size;
    }
}
