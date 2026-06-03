import type OpenAI from "openai";
import { readdir } from "fs/promises";
import type { Dirent } from "fs";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";

/**
 * 工具参数的 JSON Schema 定义。
 * 每个字段会映射到 OpenAI function calling 的 parameters.properties 中。
 */
export interface ToolParam {
    name: string;
    type: "string" | "number" | "boolean";
    description: string;
    required?: boolean;
    /** 当 type 为 "string" 时可选：限定枚举值 */
    enum?: string[];
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

    /**
     * 执行工具逻辑，由子类实现。
     *
     * @param args       工具参数
     * @param onProgress 可选 —— 流式进度回调。支持实时输出的工具（如下载器）会
     *                   逐行调用此回调；不支持的工具直接忽略。
     */
    abstract execute(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<string>;

    /** 转为 OpenAI function calling 的 tool 定义 */
    toOpenAI(): OpenAI.Chat.Completions.ChatCompletionTool {
        const properties: Record<string, Record<string, unknown>> = {};
        const required: string[] = [];

        for (const p of this.parameters) {
            properties[p.name] = {
                type: p.type,
                description: p.description,
            };
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
                name: this.name,
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

/**
 * 工具注册中心 —— 持有所有工具实例，按名称分发调用。
 */
export class ToolRegistry {
    private tools = new Map<string, BaseTool>();

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
     * 文件按名称字母顺序加载，确保跨平台/跨运行的注册顺序一致，
     * 防止因顺序差异导致 LLM prompt cache 失效。
     *
     * @param dirUrl  工具目录的 URL（通常传 `new URL("../tools", import.meta.url)`）
     */
    static async discoverAndRegister(dirUrl: URL): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        const dirPath = fileURLToPath(dirUrl);

        let entries: string[];
        try {
            entries = await readdir(dirPath);
        } catch {
            console.warn(`⚠ 工具目录不存在: ${dirPath}`);
            return registry;
        }

        // 按字母顺序排序，保证注册顺序确定性
        entries.sort((a, b) => a.localeCompare(b));

        for (const entry of entries) {
            // 跳过非工具文件及禁用/模板文件
            if (entry === "basetool.ts" || entry === "basetool.js") continue;
            if (entry.startsWith("_") || entry.startsWith(".")) continue;
            if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;

            const filePath = join(dirPath, entry);
            const fileUrl = pathToFileURL(filePath).href;

            try {
                const mod = await import(fileUrl);
                // 遍历模块导出，找出所有 BaseTool 子类并实例化注册
                for (const exported of Object.values(mod)) {
                    if (ToolRegistry.#isToolClass(exported)) {
                        const ToolClass = exported as new () => BaseTool;
                        registry.register(new ToolClass());
                    }
                }
            } catch (e) {
                console.warn(`⚠ 加载工具文件失败: ${entry} — ${e instanceof Error ? e.message : String(e)}`);
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
    static async discoverFromFolders(dirUrl: URL): Promise<ToolRegistry> {
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
                const fileUrl = pathToFileURL(filePath).href;

                try {
                    const mod = await import(fileUrl);
                    for (const exported of Object.values(mod)) {
                        if (ToolRegistry.#isToolClass(exported)) {
                            const ToolClass = exported as new () => BaseTool;
                            registry.register(new ToolClass());
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
     * - projectRoot 传入：合并模式 — 收集所有工具依赖，合并到根 package.json，
     *   在根目录一次性 npm install。
     * - projectRoot 不传：per-folder 模式 — 在每个工具文件夹内独立 npm install
     *   （用于 ~/.fyuobot/tools/ 这类没有项目根的全局工具）。
     *
     * @param toolsDir    工具根目录的路径
     * @param projectRoot 项目根目录（可选，传入则启用合并模式）
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

        if (projectRoot) {
            // ── 合并模式：合并到根 package.json ──
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
        } else {
            // ── Per-folder 模式：独立安装 ──
            let installed = 0;

            for (const { name } of toolDeps) {
                const toolDir = join(toolsDir, name);
                const nodeModulesPath = join(toolDir, "node_modules");
                if (existsSync(nodeModulesPath)) continue;

                console.log(`📦 [${name}] 正在安装依赖...`);
                try {
                    const { stdout, stderr } = await execAsync("npm install", { cwd: toolDir });
                    if (stdout) console.log(stdout);
                    if (stderr) console.warn(stderr);
                    console.log(`✅ [${name}] 依赖安装完成`);
                    installed++;
                } catch (e: any) {
                    console.warn(`⚠ [${name}] 依赖安装失败: ${e.message}`);
                    if (e.stderr) console.warn(e.stderr);
                }
            }

            return installed;
        }
    }

    /** 运行时检查一个值是否为 BaseTool 的构造函数（非抽象基类本身） */
    static #isToolClass(value: unknown): boolean {
        return (
            typeof value === "function" &&
            value !== BaseTool &&
            value.prototype instanceof BaseTool
        );
    }

    /** 生成所有已注册工具的 OpenAI tool 定义列表（按名称字母顺序，确保缓存确定性） */
    toOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return [...this.tools.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => t.toOpenAI());
    }

    /** 按名称获取工具实例（用于查询 dangerous 等元数据） */
    get(name: string): BaseTool | undefined {
        return this.tools.get(name);
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
    ): Promise<string> {
        const tool = this.tools.get(name);
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

    get size(): number {
        return this.tools.size;
    }
}
