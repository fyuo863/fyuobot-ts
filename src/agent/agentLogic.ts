// src/agent/agentLogic.ts
import { useState, useRef } from "react";
import type OpenAI from "openai";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import type { ToolRegistry } from "../tools/basetool.js";
import { router } from "../tools/router-tool.js";
import type { AgentRuntime } from "./runtime.js";

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
        content: `你是一个agent主管，可以协调多个agent完成任务。
        编码任务与审查任务必须安排给相应的agent，发布任务就不要自己读取文件。`
    },
];

/** 子 Agent 执行上限，防止闭环死循环 */
const MAX_SUB_AGENT_ROUNDS = 10;

// ── Hook ──────────────────────────────────────────────────────

export function useAgentLogic(
    registry: ToolRegistry,
    tools: OpenAI.Chat.Completions.ChatCompletionTool[],
    runtime: AgentRuntime,
) {
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

    // ── 内部：运行一轮主管 LLM（含工具调用循环） ─────────────

    /**
     * 执行一次主管 LLM 对话轮次（可能包含多轮工具调用）。
     * 返回本次新产生的 assistant/tool 消息列表。
     * 期间产生的流式文本和工具调用会自动推入 history。
     */
    const runSupervisorTurn = async (
        contextMessages: OpenAI.Chat.ChatCompletionMessageParam[],
    ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> => {
        const newMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

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
                    const toolResult = await registry.execute(tc.function.name, args);

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

    // ── 内部：本地轮询执行子 Agent 任务 ──────────────────────

    /**
     * 执行所有 pending 状态的子 Agent 任务（含链式触发）。
     *
     * 本地轮询逻辑：
     * 1. 从 Router 获取所有 pending 任务
     * 2. 按目标 Agent 名称查找 runtime 中的 Agent 实例
     * 3. 调用 agent.runTask() 同步执行（不通过 Agent 自己的轮询）
     * 4. 完成后标记 router.complete / router.fail
     * 5. 检查是否有新产生的 pending 任务（链式发布），继续执行
     * 6. 循环直到无更多 pending 任务或达到上限
     *
     * @returns 本轮新完成的任务结果摘要文本，无任务时返回 null
     */
    const executePendingSubAgentTasks = async (): Promise<string | null> => {
        const completedResults: string[] = [];
        let round = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const pendingTasks = router.getTasks({ status: "pending" });
            if (pendingTasks.length === 0) break;

            if (++round > MAX_SUB_AGENT_ROUNDS) {
                pushHistory("tool_result", `⚠️ 子Agent轮次已达上限(${MAX_SUB_AGENT_ROUNDS})，停止继续执行`);
                break;
            }

            for (const task of pendingTasks) {
                const agent = runtime.get(task.to);
                if (!agent) {
                    // 目标 Agent 不在 runtime 中（可能是主管自身或其他），跳过
                    router.fail(task.id, `目标 Agent "${task.to}" 未在 runtime 中注册`);
                    pushHistory("tool_result", `⚠️ 跳过任务 ${task.id}: Agent "${task.to}" 未找到`);
                    continue;
                }

                pushHistory(
                    "tool_call",
                    `${task.to}: 执行 ${task.type} 任务 [${task.id}]`,
                );

                try {
                    const agentResult = await agent.runTask(task);
                    router.complete(task.id, {
                        agent: task.to,
                        response: agentResult,
                    });
                    pushHistory(
                        "tool_result",
                        `✅ ${task.to}: ${agentResult.slice(0, 300)}${agentResult.length > 300 ? "..." : ""}`,
                    );
                    completedResults.push(
                        `[${task.to}] ${task.type} 任务 ${task.id}: ${agentResult}`,
                    );
                } catch (e) {
                    const errMsg = e instanceof Error ? e.message : String(e);
                    router.fail(task.id, errMsg);
                    pushHistory(
                        "tool_result",
                        `❌ ${task.to}: 任务 ${task.id} 失败 - ${errMsg}`,
                    );
                    completedResults.push(
                        `[${task.to}] ${task.type} 任务 ${task.id} 失败: ${errMsg}`,
                    );
                }
            }
        }

        if (completedResults.length === 0) return null;

        return [
            "以下子Agent完成了任务:",
            ...completedResults.map((r) => `  - ${r}`),
            "",
            "请根据以上结果决定下一步。如果所有任务已完成，给出最终回答。如果还需要修改，可以发布新任务。",
        ].join("\n");
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
            // ── 主循环：主管 LLM ↔ 本地子 Agent 执行 ──
            let keepGoing = true;
            let totalSupervisorRounds = 0;
            const MAX_SUPERVISOR_ROUNDS = 5; // 防止无限循环

            while (keepGoing && totalSupervisorRounds < MAX_SUPERVISOR_ROUNDS) {
                totalSupervisorRounds++;

                // Phase 1: 主管 LLM 运行（可能 publish_task）
                await runSupervisorTurn(contextMessages);

                // Phase 2: 本地轮询执行所有子 Agent 的 pending 任务
                const subResults = await executePendingSubAgentTasks();

                if (subResults) {
                    // Phase 3: 将子 Agent 结果注入主管上下文，继续下一轮
                    contextMessages.push({ role: "user", content: subResults });
                    setMessages([...contextMessages]);
                    // keepGoing = true → 继续循环，让主管处理结果
                } else {
                    // 无子 Agent 任务 → 主管的最后回复即最终答案
                    keepGoing = false;
                }
            }

            if (totalSupervisorRounds >= MAX_SUPERVISOR_ROUNDS) {
                pushHistory("tool_result", `⚠️ 主管轮次已达上限(${MAX_SUPERVISOR_ROUNDS})，强制结束`);
            }
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
