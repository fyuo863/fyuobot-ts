// src/tui/markdown.tsx
import React, { useMemo } from "react";
import { Text } from "ink";
import { marked } from "marked";

// 【核心修正】必须使用解构导入（Named Import），拿到真正的工厂函数
import { markedTerminal } from "marked-terminal";
import { linkifyAll } from "./linkify.js";

// 使用 as any 强行绕过 @types/marked-terminal 类型定义滞后的报错
marked.use(markedTerminal({
    // 你可以在这里自定义渲染样式
    // reflowText: true,
    // width: 80,
}) as any);

export function Markdown({ content }: { content: string }) {
    if (!content) return <Text></Text>;

    const parsedContent = useMemo(() => {
        try {
            // Step 1: 将文件路径和 URL 转为 OSC 8 超链接（Ctrl+Click 打开）
            const linkified = linkifyAll(content);
            // Step 2: Markdown → 终端 ANSI 渲染
            const raw = marked.parse(linkified) as string;
            return typeof raw === "string" ? raw.trimEnd() : content;
        } catch (err) {
            console.error("Markdown 解析失败:", err);
            return content;
        }
    }, [content]);

    return <Text>{parsedContent}</Text>;
}