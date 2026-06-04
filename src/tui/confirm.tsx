// src/tui/confirm.tsx
//
// 敏感操作确认对话框。
// 1/2 直接触发，输入框用于自定义反馈。

import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import TextInput from "ink-text-input";
import type { PendingConfirm, ConfirmResult } from "../agent/agentLogic.js";

interface ConfirmDialogProps {
    pending: PendingConfirm;
    onConfirm: (result: ConfirmResult) => void;
}

export function ConfirmDialog({ pending, onConfirm }: ConfirmDialogProps) {
    const [feedback, setFeedback] = useState("");

    useInput((_input, key) => {
        // 1：直接批准
        if (_input === "1") {
            onConfirm({ approved: true });
            return;
        }
        // 2：直接拒绝
        if (_input === "2") {
            onConfirm({ approved: false });
            return;
        }
        // Esc：拒绝
        if (key.escape) {
            onConfirm({ approved: false });
            return;
        }
        // Enter：输入框有内容 → 拒绝+反馈，空 → 批准
        if (key.return) {
            if (feedback.trim()) {
                onConfirm({ approved: false, feedback: feedback.trim() });
            } else {
                onConfirm({ approved: true });
            }
        }
    });

    const argsPreview = JSON.stringify(pending.toolArgs);
    const bar = <Text color="yellow">│ </Text>;

    return (
        <Box flexDirection="column" marginTop={1}>
            <Text>
                {bar}
                <Text bold>敏感操作</Text>
            </Text>
            <Text>
                {bar}
                <Text dimColor>工具: </Text>
                <Text>{pending.toolName}</Text>
            </Text>
            <Text>
                {bar}
                <Text dimColor>参数: </Text>
                <Text>{argsPreview}</Text>
            </Text>

            <Text>{bar}</Text>

            <Text>
                {bar}
                <Text color="green">1. 允许执行（使用原参数）</Text>
            </Text>
            <Text>
                {bar}
                <Text color="red">2. 拒绝执行</Text>
            </Text>

            <Text>{bar}</Text>

            <Text>
                {bar}
                <Text dimColor>用户输入: </Text>
            </Text>
            <Box marginLeft={3}>
                <Text color="green">{"> "}</Text>
                <TextInput
                    value={feedback}
                    onChange={setFeedback}
                    onSubmit={() => {}}
                />
            </Box>
        </Box>
    );
}
