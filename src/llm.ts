import "dotenv/config";
import OpenAI from "openai";
import * as readline from "readline/promises";

// 从环境变量读取模型配置，便于在不同供应商或模型之间切换。
const openai = new OpenAI({
    apiKey: process.env.THIRD_PARTY_API_KEY,
    baseURL: process.env.THIRD_PARTY_BASE_URL,
});

// 没有配置时使用一个默认模型，保证脚本能直接启动。
const targetModel = process.env.THIRD_PARTY_MODEL || "gpt-3.5-turbo";

// 创建交互式终端输入输出，供用户逐轮提问。
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function startChat() {
    console.log(`🤖 已连接到模型 [${targetModel}]（已开启流式传输）。输入 'exit' 退出聊天。\n`);

    // 核心改造 1：使用标准数组来维护上下文，而不是用字符串拼接
    // 这里我们借助 OpenAI SDK 自带的类型定义来确保数组格式的绝对正确
    const messagesHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: "你是一个资深的 TypeScript 导师。要求回答简明扼要。" }
    ];

    while (true) {
        const prompt = await rl.question("🧑 你: ");
        
        if (prompt.toLowerCase() === 'exit') {
            console.log("👋 聊天结束，下次见！");
            rl.close();
            break;
        }

        if (!prompt.trim()) continue;

        // 核心改造 2：将用户的新提问推入历史数组
        messagesHistory.push({ role: "user", content: prompt });

        process.stdout.write("🤖 AI: ");

        try {
            const stream = await openai.chat.completions.create({
                model: targetModel,
                messages: messagesHistory, // 直接把整个数组传给模型
                temperature: 0.7,
                stream: true,
            });

            let currentAiResponse = ""; // 只记录 AI 当前这一轮的回复

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content ?? "";
                process.stdout.write(content);
                currentAiResponse += content; // 累加当前轮次的流式内容
            }

            // 核心改造 3：AI 回答结束后，把 AI 的回答以 'assistant' 角色推入数组保存记忆
            messagesHistory.push({ role: "assistant", content: currentAiResponse });

            console.log("\n");

        } catch (error) {
            console.error("\n❌ 调用失败:", error);
        }
    }
}

startChat();