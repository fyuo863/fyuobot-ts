import { BaseTool, type ToolParam } from "../basetool.js";
import {
    getAgentChange,
    getAgentChangesRootPath,
    listAgentChanges,
    undoAgentChange,
    undoAgentChangesForTurn,
} from "./store.js";

export class AgentChangesTool extends BaseTool {
    name = "agent_changes";
    description = [
        "Inspect and undo file changes made through the agent-managed file editor.",
        "Actions: list, show, undo_last, undo_operation, undo_turn.",
        "This does not use or modify the repository's Git history.",
    ].join("\n");

    readonly dangerous = true;

    requiresConfirmation(args: Record<string, unknown>): boolean {
        const action = String(args.action ?? "");
        return (
            action === "undo_last" ||
            action === "undo_operation" ||
            action === "undo_turn"
        );
    }

    parameters: ToolParam[] = [
        {
            name: "action",
            type: "string",
            description:
                "Operation to perform: list, show, undo_last, undo_operation, undo_turn.",
            required: true,
            enum: ["list", "show", "undo_last", "undo_operation", "undo_turn"],
        },
        {
            name: "operation_id",
            type: "string",
            description: "Required for show and undo_operation.",
            required: false,
        },
        {
            name: "limit",
            type: "number",
            description: "Optional limit for list output. Defaults to 10.",
            required: false,
        },
        {
            name: "turn_id",
            type: "string",
            description: "Required for undo_turn.",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const action = String(args.action ?? "");

        switch (action) {
            case "list":
                return this.listChanges(args);
            case "show":
                return this.showChange(args);
            case "undo_last":
                return this.undoLast();
            case "undo_operation":
                return this.undoOperation(args);
            case "undo_turn":
                return this.undoTurn(args);
            default:
                return `Error: unknown action "${action}".`;
        }
    }

    private async listChanges(args: Record<string, unknown>): Promise<string> {
        const limit = Math.max(1, Number(args.limit ?? 10));
        const entries = await listAgentChanges();
        if (entries.length === 0) {
            return [
                "没有 agent 文件改动记录。",
                `存储目录: ${getAgentChangesRootPath()}`,
            ].join("\n");
        }

        const lines = entries.slice(0, limit).map((entry, index) => {
            return [
                `${index + 1}. ${entry.id}`,
                `   path=${entry.path}`,
                `   action=${entry.action} status=${entry.status}`,
                `   time=${new Date(entry.createdAt).toLocaleString("zh-CN")}`,
                `   summary=${entry.summary}`,
            ].join("\n");
        });

        return [
            `最近 ${Math.min(limit, entries.length)} 条 agent 文件改动：`,
            ...lines,
            "",
            `存储目录: ${getAgentChangesRootPath()}`,
        ].join("\n");
    }

    private async showChange(args: Record<string, unknown>): Promise<string> {
        const operationId = String(args.operation_id ?? "").trim();
        if (!operationId) {
            return "Error: action=show requires operation_id.";
        }

        const entry = await getAgentChange(operationId);
        if (!entry) {
            return `未找到改动记录: ${operationId}`;
        }

        return JSON.stringify(entry, null, 2);
    }

    private async undoLast(): Promise<string> {
        const result = await undoAgentChange();
        return result.ok
            ? `${result.message}\noperation_id=${result.entry?.id ?? ""}`
            : result.message;
    }

    private async undoOperation(args: Record<string, unknown>): Promise<string> {
        const operationId = String(args.operation_id ?? "").trim();
        if (!operationId) {
            return "Error: action=undo_operation requires operation_id.";
        }

        const result = await undoAgentChange({ id: operationId });
        return result.ok ? result.message : result.message;
    }

    private async undoTurn(args: Record<string, unknown>): Promise<string> {
        const turnId = String(args.turn_id ?? "").trim();
        if (!turnId) {
            return "Error: action=undo_turn requires turn_id.";
        }

        const result = await undoAgentChangesForTurn(turnId);
        const lines = [
            result.message,
            `turn_id=${turnId}`,
            `reverted=${result.revertedEntries.length}`,
        ];

        if (result.conflictEntry) {
            lines.push(`conflict_operation_id=${result.conflictEntry.id}`);
            lines.push(`conflict_path=${result.conflictEntry.path}`);
        }

        if (result.revertedEntries.length > 0) {
            lines.push(
                ...result.revertedEntries.map(
                    (entry, index) => `${index + 1}. ${entry.id} ${entry.path}`,
                ),
            );
        }

        return lines.join("\n");
    }
}
