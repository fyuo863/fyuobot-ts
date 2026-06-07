import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { BaseTool, type ToolParam } from "../basetool.js";

const DEFAULT_MAX_READ_CHARS = 60_000;
const MAX_WRITE_CHARS = 2_000_000;

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

function resolveWorkspacePath(filePath: string, allowOutsideWorkspace: boolean): string {
    const workspaceRoot = process.cwd();
    const absolutePath = isAbsolute(filePath)
        ? resolve(filePath)
        : resolve(workspaceRoot, filePath);

    if (allowOutsideWorkspace) {
        return absolutePath;
    }

    const rel = relative(workspaceRoot, absolutePath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
            `Path is outside workspace. Pass allow_outside_workspace=true only when explicitly intended: ${absolutePath}`,
        );
    }

    return absolutePath;
}

export class FileOperatorTool extends BaseTool {
    name = "file_operator";
    description = [
        "Read and write local text files in the current workspace.",
        "Actions: read, write, append, replace, delete.",
        "By default paths are restricted to process.cwd(); pass allow_outside_workspace=true only for explicitly intended external paths.",
        "For large files, prefer read_file_symbols and read_file_lines before full reads.",
    ].join("\n");

    readonly dangerous = true;
    readonly concurrencyKey = "file_operator";

    requiresConfirmation(args: Record<string, unknown>): boolean {
        return String(args.action ?? "") !== "read";
    }

    parameters: ToolParam[] = [
        {
            name: "action",
            type: "string",
            description: "Operation to perform: read, write, append, replace, or delete.",
            required: true,
            enum: ["read", "write", "append", "replace", "delete"],
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

    async execute(args: Record<string, unknown>): Promise<string> {
        const action = String(args.action ?? "");
        const filePath = String(args.path ?? "");
        const allowOutsideWorkspace = asBoolean(args.allow_outside_workspace);

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
                case "replace":
                    return await this.replaceFileContent(filePath, absolutePath, args);
                case "delete":
                    await rm(absolutePath, { force: false });
                    return `Deleted file: ${filePath}`;
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
    ): Promise<string> {
        const content = args.content;
        if (typeof content !== "string") {
            return `Error: action=${append ? "append" : "write"} requires string content.`;
        }
        if (content.length > MAX_WRITE_CHARS) {
            return `Error: content is too large (${content.length} chars, max ${MAX_WRITE_CHARS}).`;
        }

        const createDirs = args.create_dirs === undefined ? true : asBoolean(args.create_dirs);
        if (createDirs) {
            await mkdir(dirname(absolutePath), { recursive: true });
        }

        await writeFile(absolutePath, content, {
            encoding: "utf-8",
            flag: append ? "a" : "w",
        });

        return `${append ? "Appended to" : "Wrote"} file: ${displayPath} (${content.length} chars)`;
    }

    private async replaceFileContent(
        displayPath: string,
        absolutePath: string,
        args: Record<string, unknown>,
    ): Promise<string> {
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
        return `Replaced text in file: ${displayPath}`;
    }
}
