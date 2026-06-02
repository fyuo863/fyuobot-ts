// src/tui/markdown.tsx
import React, { useMemo } from "react";
import { Text } from "ink";
import { marked } from "marked";

// 【核心修正】必须使用解构导入（Named Import），拿到真正的工厂函数
import { markedTerminal } from "marked-terminal"; 

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
            const raw = marked.parse(content) as string;
            return typeof raw === "string" ? raw.trimEnd() : content;
        } catch (err) {
            console.error("Markdown 解析失败:", err);
            return content; 
        }
    }, [content]);

    return <Text>{parsedContent}</Text>;
}