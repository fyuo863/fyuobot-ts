// src/agent/agentLogic.ts
import { useState, useRef } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import type { Agent } from "./agent.js";

// ── 历史记录类型 ──────────────────────────────────────────────

/** 一条展示用历史记录 */
export interface HistoryEntry {
    /** 唯一标识 */
    id: number;
    /** 条目类型，决定前端渲染颜色 */
    type: "thinking" | "tool_call" | "tool_result" | "answer" | "user" | "system";
    /** 展示文本 */
    content: string;
}

// ── 常量 ──────────────────────────────────────────────────────

const INITIAL_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
        role: "system",
        content: [
            "你是一个专业的编程助手，帮助用户编写、修改和理解代码。",
            "",
            "你可以使用工具来：",
            "- 执行终端命令（execute_bash）",
            "- 读写文件（file_operator）",
            "- 以及其他可用的工具",
            "",
            "规则：",
            "- 收到请求后，先理解需求，再动手",
            "- 修改文件前先读取原始内容",
            "- 每次工具调用后，根据结果决定下一步",
            "- 任务完成后简要说明你做了什么",
        ].join("\n"),
    },
];

// ── Hook ──────────────────────────────────────────────────────

export function useAgentLogic(agent: Agent) {
    /** 仅用于 LLM 上下文的完整消息链 */
    const [messages, setMessages] = useState<OpenAI.Chat.ChatCompletionMessageParam[]>(INITIAL_MESSAGES);
    const [isThinking, setIsThinking] = useState(false);

    /** 当前轮次的流式文本（实时展示用） */
    const [streamText, setStreamText] = useState("");

    /** 展示用历史记录：每条记录独立存在，不折叠 */
    const [history, setHistory] = useState<HistoryEntry[]>([]);

    /** 自增 ID，保证每条记录的 key 稳定 */
    const historyIdRef = useRef(0);
    const pushHistory = (type: HistoryEntry["type"], content: string) => {
        const id = ++historyIdRef.current;
        setHistory((prev) => [...prev, { id, type, content }]);
    };

    // ── 流式输出节流：避免每个 token 都触发 React 重渲染 ──
    const streamTextRef = useRef("");
    const lastStreamFlushRef = useRef(0);
    const STREAM_FLUSH_MS = 50; // 20fps，大幅减少重绘次数

    /**
     * 对话计数器：每发起一次新查询 +1。
     * UI 侧用作 <Static key={conversationId}> 来强制卸载旧 Static，
     * 避免清空历史时旧条目残留。
     */
    const [conversationId, setConversationId] = useState(0);

    // ── 内部：运行 LLM 工具调用循环 ──────────────────────────

    /**
     * 执行一次 LLM 对话轮次（可能包含多轮工具调用）。
     * 返回本次新产生的 assistant/tool 消息列表。
     * 期间产生的流式文本和工具调用会自动推入 history。
     */
    const runLLMTurn = async (
        contextMessages: OpenAI.Chat.ChatCompletionMessageParam[],
    ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> => {
        const newMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        const tools = agent.registry.toOpenAITools();

        let result: SendResult;
        do {
            result = await sendMessage(contextMessages, {
                tools,
                onToken: (token) => {
                    streamTextRef.current += token;
                    const now = Date.now();
                    if (now - lastStreamFlushRef.current >= STREAM_FLUSH_MS) {
                        setStreamText(streamTextRef.current);
                        lastStreamFlushRef.current = now;
                    }
                },
            });

            // 流式结束：确保最终内容完整刷新到 UI
            setStreamText(streamTextRef.current);

            // 将最终内容固化为 answer 条目（白色）
            if (result.content) {
                pushHistory("answer", result.content);
            }
            setStreamText("");

            // 推入 assistant 消息
            const assistantMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                role: "assistant",
                content: result.content || null,
                ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
            };
            contextMessages.push(assistantMsg);
            newMessages.push(assistantMsg);

            // ── 工具调用 ──
            if (result.toolCalls?.length) {
                for (const tc of result.toolCalls) {
                    pushHistory(
                        "tool_call",
                        `${tc.function.name}(${tc.function.arguments})`,
                    );

                    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                    const toolResult = await agent.registry.execute(tc.function.name, args);

                    pushHistory("tool_result", toolResult);

                    const toolMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                        role: "tool",
                        tool_call_id: tc.id,
                        content: toolResult,
                    };
                    contextMessages.push(toolMsg);
                    newMessages.push(toolMsg);
                }
            }

            // 每轮迭代仅一次 setMessages，减少终端重绘
            setMessages([...contextMessages]);
        } while (result.toolCalls?.length);

        return newMessages;
    };

    // ── 公开接口 ────────────────────────────────────────────

    const submitQuery = async (query: string) => {
        if (!query.trim()) return;

        const contextMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...messages,
            { role: "user", content: query },
        ];

        // 立即展示用户消息
        setMessages([...contextMessages]);
        setIsThinking(true);
        setStreamText("");
        lastStreamFlushRef.current = 0;
        streamTextRef.current = "";
        setConversationId((prev) => prev + 1); // 新对话 → 新 Static 实例
        setHistory([]); // 新一轮对话清空展示历史
        pushHistory("user", query); // 用户输入存入展示历史

        try {
            // 单 Agent 直接 LLM 工具调用循环
            await runLLMTurn(contextMessages);
        } catch (error) {
            pushHistory(
                "tool_result",
                `❌ 错误: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            setIsThinking(false);
        }
    };

    return {
        /** LLM 上下文消息（保留供调试或扩展使用） */
        messages,
        isThinking,
        /** 当前流式文本，空字符串表示无活跃流 */
        streamText,
        /** 展示用历史记录：thinking=灰 / tool_call=绿 / tool_result=灰 / answer=白 */
        history,
        /** 对话序号，每轮新查询 +1。UI 用作 Static key 干净切换对话。 */
        conversationId,
        submitQuery,
    };
}
