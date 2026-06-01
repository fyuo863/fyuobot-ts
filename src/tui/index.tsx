// src/agent/index.tsx
import React from "react";
import { render } from "ink";
import { fileURLToPath } from "url";
import { ToolRegistry } from "../tools/basetool.js";
import { AgentUI } from "./ui.js";

async function bootstrap() {
    try {
        // 初始化工具
        const registry = await ToolRegistry.discoverAndRegister(
            new URL("../tools", import.meta.url)
        );
        const tools = registry.toOpenAITools();

        // 将工具和 UI 装配在一起并渲染
        render(<AgentUI registry={registry} tools={tools} />);
    } catch (error) {
        console.error("启动失败:", error);
    }
}

// 标准的主入口判断法 [cite: 37]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}