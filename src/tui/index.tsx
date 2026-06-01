// src/tui/index.tsx
import React from "react";
import { render } from "ink";
import { fileURLToPath } from "url";
import process from "process";

import { ToolRegistry } from "../tools/basetool.js";
import { router } from "../tools/router-tool.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentUI } from "./ui.js";

async function bootstrap() {
    let unmountUI: () => void;
    let runtimeInstance: AgentRuntime;

    try {
        // 1. 初始化独立后台引擎
        runtimeInstance = AgentRuntime.createDefault(router);
        runtimeInstance.startAll();

        // 2. 自动扫描并注册所有的底层执行工具
        const registry = await ToolRegistry.discoverAndRegister(
            new URL("../tools", import.meta.url)
        );
        
        // 3. 挂载 React Ink UI
        const { unmount } = render(
            <AgentUI 
                registry={registry} 
                tools={registry.toOpenAITools()} 
                runtime={runtimeInstance} 
            />
        );
        unmountUI = unmount;

        // 4. 监听退出信号（优雅降级与资源回收）
        const cleanup = () => {
            runtimeInstance.stopAll();
            if (unmountUI) unmountUI(); // 清除 Ink 动态树
            process.stdout.write('\x1b[?25h'); // 强制恢复终端光标可见
            process.exit(0);
        };

        // 捕捉用户的 Ctrl+C / 强制杀进程
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);

    } catch (error) {
        console.error("\n❌ 引擎启动遭受致命打击:", error);
        if (runtimeInstance!) runtimeInstance.stopAll();
        process.exit(1);
    }
}

// 标准 Node.js ESM 入口判定机制
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}