import type OpenAI from "openai";
import { readdir } from "fs/promises";
import { fileURLToPath, pathToFileURL } from "url";
import { join } from "path";

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
            // 跳过非工具文件
            if (entry === "basetool.ts" || entry === "basetool.js") continue;
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

    get size(): number {
        return this.tools.size;
    }
}
