import "dotenv/config";
import OpenAI from "openai";

// 初始化客户端，显式传入第三方平台的 API Key 和 Base URL
const openai = new OpenAI({
    apiKey: process.env.THIRD_PARTY_API_KEY,
    baseURL: process.env.THIRD_PARTY_BASE_URL,
});

// 从环境变量读取模型，如果未配置，给一个默认的降级选项
const targetModel = process.env.THIRD_PARTY_MODEL || "gpt-3.5-turbo";

async function chatWithLLM(prompt: string) {
    console.log(`正在使用模型 [${targetModel}] 思考中...`);

    try {
        const response = await openai.chat.completions.create({
            // 🌟 核心变化：这里不再写死，而是使用我们上面获取的模型变量
            model: targetModel, 
            messages: [
                { role: "system", content: "你是一个资深的 TypeScript 导师。要求回答简明扼要。" },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
        });

        const reply = response.choices[0]?.message?.content ?? "模型没有返回任何文本内容";
        console.log("\n🤖 AI 回复:");
        console.log(reply);

    } catch (error) {
        console.error("调用失败:", error);
    }
}

chatWithLLM("请用一句话向 Python 和 Go 开发者解释 TypeScript 的最大优势。");