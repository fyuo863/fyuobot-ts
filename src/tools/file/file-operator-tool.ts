import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
    BaseTool,
    type FileChangeArtifact,
    type ToolDiffHunk,
    type ToolExecutionOutput,
    type ToolParam,
} from "../basetool.js";
import {
    parseAllowOutsideWorkspace,
    resolveWorkspacePath,
} from "./workspace-path.js";
import { recordAgentChange } from "../agent-changes/store.js";

function extractExecutionMeta(args: Record<string, unknown>): {
    turnId?: string;
    toolCallId?: string;
} {
    const turnId =
        typeof args.__agent_turn_id === "string" && args.__agent_turn_id.trim()
            ? args.__agent_turn_id.trim()
            : undefined;
    const toolCallId =
        typeof args.__agent_tool_call_id === "string" &&
        args.__agent_tool_call_id.trim()
            ? args.__agent_tool_call_id.trim()
            : undefined;
    return {
        ...(turnId ? { turnId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
    };
}

const DEFAULT_MAX_READ_CHARS = 60_000;
const MAX_WRITE_CHARS = 2_000_000;
const DIFF_CONTEXT_LINES = 2;

function asBoolean(value: unknown): boolean {
    return value === true || value === "true";
}

function asNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function countLines(text: string): number {
    if (text.length === 0) return 1;
    return text.split(/\r?\n/).length;
}

function lineStartOffsets(text: string): number[] {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
            offsets.push(i + 1);
        }
    }
    return offsets;
}

function splitLines(text: string): string[] {
    const normalized = text.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") {
        parts.pop();
    }
    return parts;
}

function buildUnifiedDiff(
    path: string,
    before: string,
    after: string,
): { unifiedDiff: string; hunks: ToolDiffHunk[]; addedLines: number; removedLines: number } {
    const beforeLines = splitLines(before);
    const afterLines = splitLines(after);
    let start = 0;
    while (
        start < beforeLines.length &&
        start < afterLines.length &&
        beforeLines[start] === afterLines[start]
    ) {
        start += 1;
    }

    let beforeEnd = beforeLines.length - 1;
    let afterEnd = afterLines.length - 1;
    while (
        beforeEnd >= start &&
        afterEnd >= start &&
        beforeLines[beforeEnd] === afterLines[afterEnd]
    ) {
        beforeEnd -= 1;
        afterEnd -= 1;
    }

    if (start === beforeLines.length && start === afterLines.length) {
        return {
            unifiedDiff: `--- a/${path}\n+++ b/${path}\n`,
            hunks: [],
            addedLines: 0,
            removedLines: 0,
        };
    }

    const contextStart = Math.max(0, start - DIFF_CONTEXT_LINES);
    const contextBeforeEnd = Math.min(beforeLines.length - 1, beforeEnd + DIFF_CONTEXT_LINES);
    const contextAfterEnd = Math.min(afterLines.length - 1, afterEnd + DIFF_CONTEXT_LINES);

    const lines: ToolDiffHunk["lines"] = [];
    let oldLineNumber = contextStart + 1;
    let newLineNumber = contextStart + 1;
    let addedLines = 0;
    let removedLines = 0;

    for (let index = contextStart; index < start; index += 1) {
        lines.push({
            type: "context",
            oldLineNumber,
            newLineNumber,
            text: beforeLines[index] ?? "",
        });
        oldLineNumber += 1;
        newLineNumber += 1;
    }

    for (let index = start; index <= beforeEnd; index += 1) {
        lines.push({
            type: "remove",
            oldLineNumber,
            newLineNumber: null,
            text: beforeLines[index] ?? "",
        });
        oldLineNumber += 1;
        removedLines += 1;
    }

    for (let index = start; index <= afterEnd; index += 1) {
        lines.push({
            type: "add",
            oldLineNumber: null,
            newLineNumber,
            text: afterLines[index] ?? "",
        });
        newLineNumber += 1;
        addedLines += 1;
    }

    for (
        let beforeIndex = beforeEnd + 1, afterIndex = afterEnd + 1;
        beforeIndex <= contextBeforeEnd && afterIndex <= contextAfterEnd;
        beforeIndex += 1, afterIndex += 1
    ) {
        lines.push({
            type: "context",
            oldLineNumber,
            newLineNumber,
            text: beforeLines[beforeIndex] ?? "",
        });
        oldLineNumber += 1;
        newLineNumber += 1;
    }

    const oldStart = contextStart + 1;
    const oldCount = contextBeforeEnd >= contextStart ? contextBeforeEnd - contextStart + 1 : 0;
    const newStart = contextStart + 1;
    const newCount = contextAfterEnd >= contextStart ? contextAfterEnd - contextStart + 1 : 0;
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    const hunks: ToolDiffHunk[] = [
        {
            header,
            oldStart,
            oldCount,
            newStart,
            newCount,
            lines,
        },
    ];

    const diffLines = [
        `--- a/${path}`,
        `+++ b/${path}`,
        header,
        ...lines.map((line) => {
            const prefix =
                line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
            return `${prefix}${line.text}`;
        }),
    ];

    return {
        unifiedDiff: diffLines.join("\n"),
        hunks,
        addedLines,
        removedLines,
    };
}

function buildFileChangeArtifact(
    path: string,
    action: FileChangeArtifact["action"],
    before: string,
    after: string,
): FileChangeArtifact {
    const diff = buildUnifiedDiff(path, before, after);
    return {
        kind: "file_change",
        path,
        action,
        title: `${action} ${path}`,
        summary:
            diff.addedLines === 0 && diff.removedLines === 0
                ? `${path} 没有文本差异`
                : `${path} 变更: +${diff.addedLines} / -${diff.removedLines}`,
        unifiedDiff: diff.unifiedDiff,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        hunks: diff.hunks,
    };
}

export class FileOperatorTool extends BaseTool {
    name = "file_operator";
    description = [
        "Read and write local text files in the current workspace.",
        "Actions: read, write, append, insert, replace, delete.",
        "By default paths are restricted to process.cwd(); pass allow_outside_workspace=true only for explicitly intended external paths.",
        "For large files, prefer read_file_symbols and read_file_lines before full reads.",
    ].join("\n");

    readonly dangerous = true;
    readonly concurrencyKey = "file_operator";

    requiresConfirmation(args: Record<string, unknown>): boolean {
        return (
            String(args.action ?? "") !== "read" ||
            parseAllowOutsideWorkspace(args.allow_outside_workspace)
        );
    }

    parameters: ToolParam[] = [
        {
            name: "action",
            type: "string",
            description: "Operation to perform: read, write, append, insert, replace, or delete.",
            required: true,
            enum: ["read", "write", "append", "insert", "replace", "delete"],
        },
        {
            name: "path",
            type: "string",
            description: "Target file path, relative to the current workspace unless absolute.",
            required: true,
        },
        {
            name: "content",
            type: "string",
            description: "Content for write/append, or replacement content for replace.",
            required: false,
        },
        {
            name: "old_text",
            type: "string",
            description: "Exact text to replace when action=replace.",
            required: false,
        },
        {
            name: "anchor_text",
            type: "string",
            description: "Unique anchor text for action=insert.",
            required: false,
        },
        {
            name: "line_number",
            type: "number",
            description: "1-based line number for action=insert. Use total_lines+1 to append after the last line.",
            required: false,
        },
        {
            name: "insert_position",
            type: "string",
            description: "Whether to insert before or after anchor_text when action=insert. Defaults to after.",
            required: false,
            enum: ["before", "after"],
        },
        {
            name: "max_chars",
            type: "number",
            description: "Maximum characters returned for action=read. Defaults to 60000.",
            required: false,
        },
        {
            name: "create_dirs",
            type: "boolean",
            description: "Create parent directories for write/append. Defaults to true.",
            required: false,
        },
        {
            name: "allow_outside_workspace",
            type: "boolean",
            description: "Allow paths outside process.cwd(). Defaults to false.",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string | ToolExecutionOutput> {
        const action = String(args.action ?? "");
        const filePath = String(args.path ?? "");
        const allowOutsideWorkspace = parseAllowOutsideWorkspace(
            args.allow_outside_workspace,
        );

        if (!action) return "Error: missing action.";
        if (!filePath) return "Error: missing path.";

        let absolutePath: string;
        try {
            absolutePath = resolveWorkspacePath(filePath, allowOutsideWorkspace);
        } catch (error) {
            return `File operation rejected: ${error instanceof Error ? error.message : String(error)}`;
        }

        try {
            switch (action) {
                case "read":
                    return await this.readFileContent(filePath, absolutePath, args);
                case "write":
                    return await this.writeFileContent(filePath, absolutePath, args, false);
                case "append":
                    return await this.writeFileContent(filePath, absolutePath, args, true);
                case "insert":
                    return await this.insertFileContent(filePath, absolutePath, args);
                case "replace":
                    return await this.replaceFileContent(filePath, absolutePath, args);
                case "delete":
                    return await this.deleteFile(filePath, absolutePath, args);
                default:
                    return `Error: unknown file action "${action}".`;
            }
        } catch (error) {
            return `File operation failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async readFileContent(
        displayPath: string,
        absolutePath: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        const info = await stat(absolutePath);
        if (!info.isFile()) {
            return `Error: path is not a file: ${displayPath}`;
        }

        const content = await readFile(absolutePath, "utf-8");
        const maxChars = Math.max(1, asNumber(args.max_chars, DEFAULT_MAX_READ_CHARS));
        const truncated = content.length > maxChars;
        const body = truncated ? content.slice(0, maxChars) : content;

        return [
            `[file: ${displayPath}]`,
            `size: ${formatBytes(info.size)}`,
            `chars: ${content.length}${truncated ? `, returned first ${maxChars}` : ""}`,
            "",
            body,
            truncated ? "\n[truncated: increase max_chars or use read_file_lines for a range]" : "",
        ]
            .filter(Boolean)
            .join("\n");
    }

    private async writeFileContent(
        displayPath: string,
        absolutePath: string,
        args: Record<string, unknown>,
        append: boolean,
    ): Promise<string | ToolExecutionOutput> {
        const content = args.content;
        if (typeof content !== "string") {
            return `Error: action=${append ? "append" : "write"} requires string content.`;
        }
        if (content.length > MAX_WRITE_CHARS) {
            return `Error: content is too large (${content.length} chars, max ${MAX_WRITE_CHARS}).`;
        }

        const beforeExists = append
            ? await stat(absolutePath)
                  .then((info) => info.isFile())
                  .catch(() => false)
            : await stat(absolutePath)
                  .then((info) => info.isFile())
                  .catch(() => false);
        const before = beforeExists
            ? await readFile(absolutePath, "utf-8")
            : "";
        const createDirs = args.create_dirs === undefined ? true : asBoolean(args.create_dirs);
        if (createDirs) {
            await mkdir(dirname(absolutePath), { recursive: true });
        }

        await writeFile(absolutePath, content, {
            encoding: "utf-8",
            flag: append ? "a" : "w",
        });
        const after = append ? before + content : content;
        const artifact = buildFileChangeArtifact(
            displayPath,
            append ? "append" : "write",
            before,
            after,
        );
        const summary = `${append ? "Appended to" : "Wrote"} file: ${displayPath} (+${artifact.addedLines} / -${artifact.removedLines})`;
        const changeEntry = await recordAgentChange({
            action: append ? "append" : "write",
            path: displayPath,
            absolutePath,
            summary,
            beforeContent: before,
            afterContent: after,
            beforeExists,
            afterExists: true,
            ...extractExecutionMeta(args),
        });
        return {
            content: [
                summary,
                `operation_id: ${changeEntry.id}`,
                "```diff",
                artifact.unifiedDiff,
                "```",
            ].join("\n"),
            summary,
            artifacts: [artifact],
        };
    }

    private async insertFileContent(
        displayPath: string,
        absolutePath: string,
        args: Record<string, unknown>,
    ): Promise<string | ToolExecutionOutput> {
        const content = args.content;
        if (typeof content !== "string") {
            return "Error: action=insert requires string content.";
        }
        if (content.length > MAX_WRITE_CHARS) {
            return `Error: content is too large (${content.length} chars, max ${MAX_WRITE_CHARS}).`;
        }

        const original = await readFile(absolutePath, "utf-8");
        const insertPosition =
            args.insert_position === "before" ? "before" : "after";
        const lineNumberRaw = args.line_number;
        const lineNumber = Number(lineNumberRaw);

        if (Number.isFinite(lineNumber)) {
            return this.insertAtLine(
                displayPath,
                absolutePath,
                original,
                content,
                lineNumber,
                args,
            );
        }

        const anchorText = args.anchor_text;
        if (typeof anchorText !== "string" || anchorText.length === 0) {
            return "Error: action=insert requires either line_number or non-empty anchor_text.";
        }

        const firstIndex = original.indexOf(anchorText);
        if (firstIndex === -1) {
            return "Error: anchor_text was not found. Read the file first and pass an exact snippet.";
        }

        const secondIndex = original.indexOf(
            anchorText,
            firstIndex + anchorText.length,
        );
        if (secondIndex !== -1) {
            return "Error: anchor_text occurs multiple times. Use a larger unique snippet.";
        }

        const insertionIndex =
            insertPosition === "before"
                ? firstIndex
                : firstIndex + anchorText.length;
        const updated =
            original.slice(0, insertionIndex) +
            content +
            original.slice(insertionIndex);

        if (updated.length > MAX_WRITE_CHARS) {
            return `Error: resulting file is too large (${updated.length} chars, max ${MAX_WRITE_CHARS}).`;
        }

        await writeFile(absolutePath, updated, "utf-8");
        const artifact = buildFileChangeArtifact(
            displayPath,
            "insert",
            original,
            updated,
        );
        const summary = `Inserted text in file: ${displayPath} (+${artifact.addedLines} / -${artifact.removedLines})`;
        const changeEntry = await recordAgentChange({
            action: "insert",
            path: displayPath,
            absolutePath,
            summary,
            beforeContent: original,
            afterContent: updated,
            beforeExists: true,
            afterExists: true,
            ...extractExecutionMeta(args),
        });
        return {
            content: [
                summary,
                `operation_id: ${changeEntry.id}`,
                `mode: ${insertPosition} anchor_text`,
                `inserted_chars: ${content.length}`,
                `inserted_lines: ${countLines(content)}`,
                "```diff",
                artifact.unifiedDiff,
                "```",
            ].join("\n"),
            summary,
            artifacts: [artifact],
        };
    }

    private async replaceFileContent(
        displayPath: string,
        absolutePath: string,
        args: Record<string, unknown>,
    ): Promise<string | ToolExecutionOutput> {
        const oldText = args.old_text;
        const content = args.content;
        if (typeof oldText !== "string" || oldText.length === 0) {
            return "Error: action=replace requires non-empty old_text.";
        }
        if (typeof content !== "string") {
            return "Error: action=replace requires string content.";
        }

        const original = await readFile(absolutePath, "utf-8");
        const firstIndex = original.indexOf(oldText);
        if (firstIndex === -1) {
            return "Error: old_text was not found. Read the file first and pass an exact snippet.";
        }

        const secondIndex = original.indexOf(oldText, firstIndex + oldText.length);
        if (secondIndex !== -1) {
            return "Error: old_text occurs multiple times. Use a larger unique snippet.";
        }

        const updated = original.slice(0, firstIndex) + content + original.slice(firstIndex + oldText.length);
        if (updated.length > MAX_WRITE_CHARS) {
            return `Error: resulting file is too large (${updated.length} chars, max ${MAX_WRITE_CHARS}).`;
        }

        await writeFile(absolutePath, updated, "utf-8");
        const artifact = buildFileChangeArtifact(
            displayPath,
            "replace",
            original,
            updated,
        );
        const summary = `Replaced text in file: ${displayPath} (+${artifact.addedLines} / -${artifact.removedLines})`;
        const changeEntry = await recordAgentChange({
            action: "replace",
            path: displayPath,
            absolutePath,
            summary,
            beforeContent: original,
            afterContent: updated,
            beforeExists: true,
            afterExists: true,
            ...extractExecutionMeta(args),
        });
        return {
            content: [
                summary,
                `operation_id: ${changeEntry.id}`,
                `old_chars: ${oldText.length}`,
                `new_chars: ${content.length}`,
                `delta_chars: ${content.length - oldText.length}`,
                "```diff",
                artifact.unifiedDiff,
                "```",
            ].join("\n"),
            summary,
            artifacts: [artifact],
        };
    }

    private async insertAtLine(
        displayPath: string,
        absolutePath: string,
        original: string,
        content: string,
        rawLineNumber: number,
        args: Record<string, unknown>,
    ): Promise<string | ToolExecutionOutput> {
        const lineNumber = Math.trunc(rawLineNumber);
        if (lineNumber < 1) {
            return "Error: line_number must be >= 1.";
        }

        const offsets = lineStartOffsets(original);
        const totalLines = offsets.length;
        if (lineNumber > totalLines + 1) {
            return `Error: line_number ${lineNumber} is beyond the valid insertion range (1-${totalLines + 1}).`;
        }

        const insertionIndex =
            lineNumber === totalLines + 1
                ? original.length
                : offsets[lineNumber - 1] ?? original.length;
        const updated =
            original.slice(0, insertionIndex) +
            content +
            original.slice(insertionIndex);

        if (updated.length > MAX_WRITE_CHARS) {
            return `Error: resulting file is too large (${updated.length} chars, max ${MAX_WRITE_CHARS}).`;
        }

        await writeFile(absolutePath, updated, "utf-8");
        const artifact = buildFileChangeArtifact(
            displayPath,
            "insert",
            original,
            updated,
        );
        const summary = `Inserted text in file: ${displayPath} (+${artifact.addedLines} / -${artifact.removedLines})`;
        const changeEntry = await recordAgentChange({
            action: "insert",
            path: displayPath,
            absolutePath,
            summary,
            beforeContent: original,
            afterContent: updated,
            beforeExists: true,
            afterExists: true,
            ...extractExecutionMeta(args),
        });
        return {
            content: [
                summary,
                `operation_id: ${changeEntry.id}`,
                `mode: before line ${lineNumber}`,
                `inserted_chars: ${content.length}`,
                `inserted_lines: ${countLines(content)}`,
                "```diff",
                artifact.unifiedDiff,
                "```",
            ].join("\n"),
            summary,
            artifacts: [artifact],
        };
    }

    private async deleteFile(
        displayPath: string,
        absolutePath: string,
        args?: Record<string, unknown>,
    ): Promise<string> {
        const info = await stat(absolutePath);
        if (!info.isFile()) {
            throw new Error(`path is not a file: ${displayPath}`);
        }
        const before = await readFile(absolutePath, "utf-8");
        await rm(absolutePath, { force: false });
        const summary = `Deleted file: ${displayPath}`;
        const changeEntry = await recordAgentChange({
            action: "delete",
            path: displayPath,
            absolutePath,
            summary,
            beforeContent: before,
            afterContent: "",
            beforeExists: true,
            afterExists: false,
            ...extractExecutionMeta(args ?? {}),
        });
        return `${summary}\noperation_id: ${changeEntry.id}`;
    }
}
