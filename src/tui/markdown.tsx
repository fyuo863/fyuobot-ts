// src/tui/markdown.tsx
import React from "react";
import { Text } from "ink";

/** 将 **粗体** 标记解析为 Ink <Text bold> 组件 */
function renderWithBold(content: string): React.ReactNode[] {
    const parts = content.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
        const match = part.match(/^\*\*(.+)\*\*$/);
        if (match) {
            return (
                <Text key={i} bold>
                    {match[1]}
                </Text>
            );
        }
        return <Text key={i}>{part}</Text>;
    });
}

export function Markdown({ content }: { content: string }) {
    if (!content) return <Text></Text>;

    try {
        return <Text>{renderWithBold(content)}</Text>;
    } catch {
        return <Text>{content}</Text>;
    }
}
