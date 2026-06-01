import * as readline from "readline/promises";
import type OpenAI from "openai";
import { fileURLToPath } from "url";
import { sendMessage } from "../llm/llm.js";
import type { SendResult } from "../llm/llm.js";
import { ToolRegistry } from "../tools/basetool.js";

/**
 * 启动 agent 交互循环。
 * 自动扫描 tools/ 目录发现并注册所有工具。
 * 支持 tool calling：当 LLM 返回 tool_calls 时自动执行工具、回传结果并继续推理。
 */
export async function newAgent() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    // 自动扫描 tools/ 目录，发现并注册所有 BaseTool 子类
    const registry = await ToolRegistry.discoverAndRegister(
        new URL("../tools", import.meta.url),
    );
    const tools = registry.toOpenAITools();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: "你是一个资深的 TypeScript 导师，可以使用工具来辅助回答。"
        },
    ];

    console.log(`🤖 Agent 已启动（已加载 ${registry.size} 个工具）。输入 'q' 退出。\n`);

    while (true) {
        const prompt = await rl.question("🧑 你: ");

        if (prompt.toLowerCase() === "q") {
            console.log("👋 Agent 结束，下次见！");
            rl.close();
            break;
        }

        if (!prompt.trim()) continue;

        messages.push({ role: "user", content: prompt });
        process.stdout.write("🤖 AI: ");

        try {
            // ---- 工具调用循环：LLM 可能连续多次请求工具 ----
            let result: SendResult;
            let firstTurn = true;

            do {
                result = await sendMessage(messages, {
                    tools,
                    onToken: (token) => { process.stdout.write(token); },
                });

                // 将 assistant 消息推入历史
                messages.push({
                    role: "assistant",
                    content: result.content || null,
                    ...(result.toolCalls?.length
                        ? { tool_calls: result.toolCalls }
                        : {}),
                });

                if (result.toolCalls?.length) {
                    // 跳过后续工具轮次的 "🤖 AI:" 前缀
                    if (!firstTurn) console.log();

                    for (const tc of result.toolCalls) {
                        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        const toolResult = await registry.execute(tc.function.name, args);

                        process.stdout.write(`\n🔧 调用工具 ${tc.function.name}(${tc.function.arguments}) → ${toolResult}\n🤖 AI: `);

                        messages.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: toolResult,
                        });
                    }
                }

                firstTurn = false;
            } while (result.toolCalls?.length);

            console.log("\n");

        } catch (error) {
            console.error("\n❌ 调用失败:", error);
        }
    }
}

// 直接运行时启动
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    newAgent();
}
