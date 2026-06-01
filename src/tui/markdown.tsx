import React, { useMemo } from "react";
import { Text } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// 🚀 使用 as any 绕过 @types/marked-terminal 落后的类型定义
marked.use(markedTerminal() as any);

interface MarkdownProps {
    content: string;
}

export function Markdown({ content }: MarkdownProps) {
    const renderedText = useMemo(() => {
        if (!content) return "";
        try {
            const parsed = marked.parse(content);
            return typeof parsed === "string" ? parsed.trim() : content;
        } catch (error) {
            return content; 
        }
    }, [content]);

    return <Text>{renderedText}</Text>;
}