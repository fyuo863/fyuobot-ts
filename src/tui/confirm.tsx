// src/tui/confirm.tsx
//
// 敏感操作确认对话框 —— 类似 Claude Code 的 Yes/No 确认提示。
// 使用 Ink 的 useInput hook 捕获键盘输入。

import React from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { PendingConfirm } from "../agent/agentLogic.js";

interface ConfirmDialogProps {
    /** 待确认的操作信息 */
    pending: PendingConfirm;
    /** 用户选择后的回调 */
    onConfirm: (approved: boolean) => void;
}

export function ConfirmDialog({ pending, onConfirm }: ConfirmDialogProps) {
    useInput((input, key) => {
        if (key.return) { onConfirm(true); return; }
        const ch = input.toLowerCase();
        if (ch === "y") onConfirm(true);
        if (ch === "n") onConfirm(false);
    });

    const argsPreview = JSON.stringify(pending.toolArgs);
    const truncated = argsPreview.length > 120
        ? argsPreview.slice(0, 120) + "..."
        : argsPreview;

    // 用 Text 嵌套构建左侧竖线前缀的行，确保竖线与内容等高
    const bar = <Text color="yellow">│ </Text>;

    return (
        <Box flexDirection="column" marginTop={1}>
            <Text>{bar}<Text bold color="yellow">允许 fyuobot 执行以下操作</Text></Text>
            <Text>{bar}<Text dimColor>工具: </Text><Text color="red" bold>{pending.toolName}</Text></Text>
            <Text>{bar}<Text dimColor>参数: </Text><Text>{truncated}</Text></Text>
            <Text>{bar}</Text>
            <Text>
                {bar}
                <Text color="green" bold>[Y/Enter] 确认执行</Text>
                <Text>{"  "}</Text>
                <Text color="red" bold>[N] 取消</Text>
            </Text>
        </Box>
    );
}
