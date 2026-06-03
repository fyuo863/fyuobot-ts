import "dotenv/config";
import OpenAI from "openai";

// 从环境变量读取模型配置，便于在不同供应商或模型之间切换。
const openai = new OpenAI({
    apiKey: process.env.THIRD_PARTY_API_KEY,
    baseURL: process.env.THIRD_PARTY_BASE_URL,
});

// 没有配置时使用一个默认模型，保证脚本能直接启动。
const targetModel = process.env.THIRD_PARTY_MODEL || "gpt-3.5-turbo";

/** 单个 function tool call（窄化类型，仅保留 function 调用） */
export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string; // JSON 字符串
    };
}

/** sendMessage 的返回值：可直接推入 messages 历史的 assistant 消息 */
export interface SendResult {
    /** 模型文本回复（可能为空字符串，当仅返回 tool_calls 时） */
    content: string;
    /** 模型请求的工具调用列表 */
    toolCalls?: ToolCall[];
    /**
     * 原始 usage 对象（来自流式响应的最终 chunk）。
     * 各厂商字段不同 —— 通过 middleware 统一解析。
     */
    usage?: Record<string, unknown>;
}

/**
 * 单次 LLM 调用：传入完整消息历史，返回 assistant 消息。
 * 调用方负责维护 messages 数组。
 *
 * @param messages  完整的对话历史
 * @param options.tools    可选的 OpenAI tool 定义列表
 * @param options.onToken  可选回调，每收到一个文本 token 时调用
 * @returns                assistant 消息（含 content 和可选的 tool_calls）
 */
export async function sendMessage(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options?: {
        tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
        onToken?: (token: string) => void;
    },
): Promise<SendResult> {
    const stream = await openai.chat.completions.create({
        model: targetModel,
        messages,
        temperature: 0.7,
        stream: true,
        stream_options: { include_usage: true },
        ...(options?.tools?.length ? { tools: options.tools } : {}),
    });

    let content = "";
    /** 按索引导入合并 tool_calls delta（流式下分片到达） */
    const toolCallMap = new Map<number, {
        id: string;
        name: string;
        arguments: string;
    }>();

    // 捕获最终 chunk 中携带的 usage（各厂商字段可能超出 OpenAI 类型定义）
    let rawUsage: Record<string, unknown> | undefined;

    for await (const chunk of stream) {
        // 最终 chunk 携带 usage（choices 通常为空）
        if (chunk.usage) {
            rawUsage = chunk.usage as unknown as Record<string, unknown>;
        }

        const delta = chunk.choices[0]?.delta;

        // 文本 token
        if (delta?.content) {
            content += delta.content;
            options?.onToken?.(delta.content);
        }

        // 工具调用 delta（可能跨多个 chunk 到达）
        if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallMap.has(idx)) {
                    toolCallMap.set(idx, {
                        id: tc.id ?? "",
                        name: tc.function?.name ?? "",
                        arguments: "",
                    });
                }
                const entry = toolCallMap.get(idx)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
        }
    }

    const result: SendResult = { content };
    if (rawUsage !== undefined) {
        result.usage = rawUsage;
    }

    if (toolCallMap.size > 0) {
        result.toolCalls = [...toolCallMap.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]): ToolCall => ({
                id: tc.id,
                type: "function",
                function: {
                    name: tc.name,
                    arguments: tc.arguments,
                },
            }));
    }

    return result;
}
