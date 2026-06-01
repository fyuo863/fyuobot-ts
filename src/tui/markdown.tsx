// src/tui/markdown.tsx
import React from "react";
import { Text } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// 使用 as any 绕过落后的类型定义
marked.use(markedTerminal() as any);

export function Markdown({ content }: { content: string }) {
    if (!content) return <Text></Text>;

    try {
        const parsed = marked.parse(content);
        const renderedText = typeof parsed === "string" ? parsed.trim() : content;
        return <Text>{renderedText}</Text>;
    } catch (error) {
        // Fallback to raw content if parsing miraculously fails
        return <Text>{content}</Text>;
    }
}