// src/tui/index.tsx
import React from "react";
import { render } from "ink";
import { fileURLToPath } from "url";
import { ToolRegistry } from "../tools/basetool.js";
import { router } from "../tools/router-tool.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentUI } from "./ui.js";

async function bootstrap() {
    try {
        // ── 1. 创建并启动独立 Agent 运行时 ──
        // router 是 router-tool.ts 中导出的共享单例，
        // 保证工具调用（publish_task 等）和 Agent 轮询操作的是同一份数据。
        const runtime = AgentRuntime.createDefault(router);
        runtime.startAll();
        console.log(`🤖 已启动 ${runtime.agentCount} 个后台 Agent`);

        // ── 2. 初始化用户侧工具 ──
        // 自动发现 src/tools 下所有工具（含 router 工具），
        // 用户通过 TUI 可直接调度 coder / reviewer。
        const registry = await ToolRegistry.discoverAndRegister(
            new URL("../tools", import.meta.url),
        );
        const tools = registry.toOpenAITools();

        // ── 3. 启动 TUI ──
        const { unmount } = render(
            <AgentUI registry={registry} tools={tools} runtime={runtime} />,
        );

        // 退出时清理
        const cleanup = () => {
            runtime.stopAll();
            unmount();
            process.exit(0);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
    } catch (error) {
        console.error("启动失败:", error);
        process.exit(1);
    }
}

// 标准主入口判断
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}
