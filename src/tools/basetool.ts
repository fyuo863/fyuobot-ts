import type OpenAI from "openai";

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

    /** 执行工具逻辑，由子类实现 */
    abstract execute(args: Record<string, unknown>): Promise<string>;

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

    /** 生成所有已注册工具的 OpenAI tool 定义列表 */
    toOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return [...this.tools.values()].map((t) => t.toOpenAI());
    }

    /** 按名称执行工具 */
    async execute(name: string, args: Record<string, unknown>): Promise<string> {
        const tool = this.tools.get(name);
        if (!tool) {
            return `Error: unknown tool "${name}"`;
        }
        try {
            return await tool.execute(args);
        } catch (e) {
            return `Error executing "${name}": ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    get size(): number {
        return this.tools.size;
    }
}
