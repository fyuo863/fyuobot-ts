// src/tui/index.tsx
import React from "react";
import { render } from "ink";
import { fileURLToPath } from "url";
import process from "process";

import { ToolRegistry } from "../tools/basetool.js";
import { router } from "../tools/router-tool.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentUI } from "./ui.js";

// ── 开场 Banner 渲染（原生 ANSI 字符画与信息框） ──
function printBanner(toolCount: number) {
    const LOGO_LINES = [
        "  ██  █  █ █  █  ██  █     ██   █  ",
        "  █   █  █ █  █ █  █ ███  █  █ ███ ",
        "  ███  ███ █  █ █  █ █  █ █  █  █  ",
        "  █      █  ██   ██  ███   ██   ██ ",
        ""
    ];

    console.log(); // 顶层留白
    
    // 1. 打印 Logo
    LOGO_LINES.forEach((row, y, arr) => {
        let line = "";
        for (let x = 0; x < 35; x++) {
            const isMain = row[x] === "█";
            const isShadow = y > 0 && x > 0 && arr[y - 1]?.[x - 1] === "█";
            
            if (isMain) {
                line += "\x1b[47m \x1b[0m"; // 白块
            } else if (isShadow) {
                line += "\x1b[90m⣿\x1b[0m"; // 灰影
            } else {
                line += " ";
            }
        }
        console.log(line);
    });

    // 2. 打印带有青色 (Cyan) 边框的系统信息框
    console.log(`\x1b[0m  📁 当前目录: \x1b[1m${process.cwd()}\x1b[0m`);
    console.log(`\x1b[0m  💡 系统状态: 已加载 \x1b[32m${toolCount}\x1b[0m 个工具`);
    console.log();
}

async function bootstrap() {
    try {
        // 1. 创建并启动独立 Agent 运行时
        const runtime = AgentRuntime.createDefault(router);
        runtime.startAll();

        // 2. 自动发现并注册工具
        // 注意：把这步提到打印 Banner 前面，以便获取 registry.size
        const registry = await ToolRegistry.discoverAndRegister(
            new URL("../tools", import.meta.url)
        );
        
        // 3. 打印开场 Banner
        printBanner(registry.size);
        console.log(`🤖 已启动 ${runtime.agentCount} 个后台 Agent`);

        // 4. 启动 TUI 终端界面
        const { unmount } = render(
            <AgentUI 
                registry={registry} 
                tools={registry.toOpenAITools()} 
                runtime={runtime} 
            />
        );

        // 5. 监听退出信号
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    bootstrap();
}