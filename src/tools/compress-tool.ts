import * as fs from "fs/promises";
import * as path from "path";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

const MEMORY_FILES: Record<string, string> = {
    history: "HISTORY.md",
    memory: "MEMORY.md",
    user: "USER.md",
    all: "",
};

const MEMORIES_DIR = path.resolve(process.cwd(), ".fyuobot", "memories");

export const MEMORY_FILE_SIZE_THRESHOLD = 50 * 1024;
const TRUNCATE_KEEP = 12_000;

export function compressContent(
    content: string,
    strategy: string,
): { result: string; strategy: string } {
    if (!content.trim()) {
        return { result: content, strategy: "skip (empty)" };
    }

    const size = Buffer.byteLength(content, "utf-8");
    if (strategy === "auto" && size < MEMORY_FILE_SIZE_THRESHOLD) {
        return { result: content, strategy: "skip (under threshold)" };
    }

    const effectiveStrategy = strategy === "auto" ? "summarize" : strategy;
    switch (effectiveStrategy) {
        case "truncate":
            return { result: truncateContent(content), strategy: "truncate" };
        case "summarize":
            return { result: summarizeContent(content), strategy: "summarize" };
        default:
            return { result: content, strategy: "skip (unknown strategy)" };
    }
}

function truncateContent(content: string): string {
    if (content.length <= TRUNCATE_KEEP) return content;

    const header = "> Older content was truncated by automatic compression.\n\n";
    const kept = content.slice(-TRUNCATE_KEEP);
    const firstNewline = kept.indexOf("\n");
    const cleanKept = firstNewline > 0 ? kept.slice(firstNewline + 1) : kept;

    return header + cleanKept;
}

function summarizeContent(content: string): string {
    const sections = splitByH1(content);
    if (sections.length <= 3) {
        return summarizeByH2(content);
    }

    const keepCount = 3;
    const oldSections = sections.slice(0, -keepCount);
    const recentSections = sections.slice(-keepCount);

    const parts: string[] = [];
    parts.push(
        "> Compressed summary of older content. Detailed text was removed; headings remain for search.\n",
    );
    for (const sec of oldSections) {
        const title = extractTitle(sec);
        const brief = extractBrief(sec);
        parts.push(`### ${title}\n> ${brief}\n`);
    }

    parts.push("---\n");
    parts.push("> Recent records are kept in full.\n");
    parts.push(...recentSections);

    return parts.join("\n");
}

function summarizeByH2(content: string): string {
    const sections = splitByH2(content);
    if (sections.length <= 5) return content;

    const keepCount = 5;
    const oldSections = sections.slice(0, -keepCount);
    const recentSections = sections.slice(-keepCount);

    const parts: string[] = [];
    parts.push("> Compressed summary of older content.\n");
    for (const sec of oldSections) {
        const title = extractTitle(sec);
        parts.push(`- **${title}**: *(compressed)*`);
    }
    parts.push("\n---\n");
    parts.push("> Recent records are kept in full.\n");
    parts.push(...recentSections);

    return parts.join("\n");
}

function splitByH1(content: string): string[] {
    const lines = content.split("\n");
    const sections: string[] = [];
    let current = "";

    for (const line of lines) {
        if (/^#\s/.test(line) && current.trim()) {
            sections.push(current.trimEnd());
            current = line + "\n";
        } else {
            current += line + "\n";
        }
    }
    if (current.trim()) sections.push(current.trimEnd());
    return sections;
}

function splitByH2(content: string): string[] {
    const lines = content.split("\n");
    const sections: string[] = [];
    let current = "";

    for (const line of lines) {
        if (/^##\s/.test(line) && current.trim()) {
            sections.push(current.trimEnd());
            current = line + "\n";
        } else {
            current += line + "\n";
        }
    }
    if (current.trim()) sections.push(current.trimEnd());
    return sections;
}

function extractTitle(section: string): string {
    const match = section.match(/^#+\s*(.+)/m);
    return match?.[1]?.trim() ?? "(untitled)";
}

function extractBrief(section: string): string {
    const lines = section.split("\n");
    let afterTitle = false;
    const contentLines: string[] = [];

    for (const line of lines) {
        if (!afterTitle && /^#+\s/.test(line)) {
            afterTitle = true;
            continue;
        }
        if (afterTitle && line.trim() && !line.startsWith(">")) {
            contentLines.push(line.trim());
        }
    }

    const brief = contentLines.join(" ").slice(0, 120);
    return brief || "(no detail)";
}

export class CompressTool extends BaseTool {
    name = "compress";
    description = [
        "Compress memory files to control token usage.",
        "",
        "HISTORY.md: triggers LLM batch condensation into SQLite archive.",
        "MEMORY.md / USER.md: keeps markdown structure and recent sections while compacting older content.",
        "",
        "Strategy:",
        "- auto: choose automatically",
        "- truncate: keep only the latest content",
        "- summarize: keep headings and recent sections, compact older sections",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "file",
            type: "string",
            description: "Memory file to compress: history, memory, user, or all",
            required: true,
            enum: ["history", "memory", "user", "all"],
        },
        {
            name: "strategy",
            type: "string",
            description: "Compression strategy: auto, truncate, or summarize",
            required: false,
            enum: ["auto", "truncate", "summarize"],
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const file = args["file"] as string;
        const strategy = (args["strategy"] as string) || "auto";

        if (file === "all") {
            return this.#compressAll(strategy);
        }

        const fileName = MEMORY_FILES[file];
        if (!fileName) {
            return `Unknown memory file: "${file}". Expected history, memory, user, or all.`;
        }

        return this.#compressOne(fileName, strategy);
    }

    async #compressOne(fileName: string, strategy: string): Promise<string> {
        if (fileName === "HISTORY.md") {
            return this.#compressHistory();
        }

        const filePath = path.join(MEMORIES_DIR, fileName);
        let content: string;
        try {
            content = await fs.readFile(filePath, "utf-8");
        } catch {
            return `Cannot read ${fileName}; file may not exist.`;
        }

        const originalSize = Buffer.byteLength(content, "utf-8");
        const { result, strategy: used } = compressContent(content, strategy);
        if (result === content) {
            return `${fileName} does not need compression (${(originalSize / 1024).toFixed(1)} KB, strategy: ${used}).`;
        }

        await fs.mkdir(MEMORIES_DIR, { recursive: true });
        await fs.writeFile(filePath, result, "utf-8");

        const compressedSize = Buffer.byteLength(result, "utf-8");
        const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(0);

        return [
            `Compressed ${fileName}:`,
            `strategy: ${used}`,
            `before: ${(originalSize / 1024).toFixed(1)} KB`,
            `after: ${(compressedSize / 1024).toFixed(1)} KB`,
            `reduction: ${reduction}%`,
        ].join("\n");
    }

    async #compressHistory(): Promise<string> {
        const { HistoryManager } = await import("../memory/history-manager.js");
        const hm = HistoryManager.instance();
        const before = hm.getBufferStats();
        const didCondense = await hm.checkAndCondense();

        if (!didCondense) {
            return `HISTORY.md buffer is under threshold (${before.charCount} / ${before.threshold} chars).`;
        }

        const after = hm.getBufferStats();
        const stats = hm.getStats();
        return [
            "HISTORY.md condensation triggered:",
            `before: ${(before.charCount / 1024).toFixed(1)} KB`,
            `after: ${(after.charCount / 1024).toFixed(1)} KB`,
            `archived conversations: ${stats.conversationCount} (${stats.dbSizeKB} KB)`,
        ].join("\n");
    }

    async #compressAll(strategy: string): Promise<string> {
        const files = ["HISTORY.md", "MEMORY.md", "USER.md"];
        const reports: string[] = [];
        for (const fileName of files) {
            reports.push(await this.#compressOne(fileName, strategy));
        }
        return reports.join("\n\n");
    }

    static async checkAll(): Promise<
        Array<{ file: string; charCount: number; threshold: number; needsAction: boolean }>
    > {
        const { HistoryManager } = await import("../memory/history-manager.js");
        const hm = HistoryManager.instance();
        const history = hm.getBufferStats();
        const memory = hm.getSystemMemoryStats();
        const user = hm.getUserMemoryStats();
        return [
            {
                file: "HISTORY.md",
                charCount: history.charCount,
                threshold: history.threshold,
                needsAction: history.charCount > history.threshold,
            },
            {
                file: "MEMORY.md",
                charCount: memory.charCount,
                threshold: memory.threshold,
                needsAction: memory.charCount > memory.threshold,
            },
            {
                file: "USER.md",
                charCount: user.charCount,
                threshold: user.threshold,
                needsAction: user.charCount > user.threshold,
            },
        ];
    }

    static async autoCompress(): Promise<string[]> {
        const { HistoryManager } = await import("../memory/history-manager.js");
        const hm = HistoryManager.instance();
        const logs: string[] = [];
        const history = hm.getBufferStats();
        const memory = hm.getSystemMemoryStats();
        const user = hm.getUserMemoryStats();

        if (
            history.charCount > history.threshold ||
            memory.charCount > memory.threshold ||
            user.charCount > user.threshold
        ) {
            await hm.checkAndCondense();
            const afterHistory = hm.getBufferStats();
            const afterMemory = hm.getSystemMemoryStats();
            const afterUser = hm.getUserMemoryStats();

            if (history.charCount > history.threshold) {
                logs.push(
                    `HISTORY.md auto-condensed (${(history.charCount / 1024).toFixed(0)}KB -> ${(afterHistory.charCount / 1024).toFixed(0)}KB)`,
                );
            }
            if (memory.charCount > memory.threshold) {
                logs.push(
                    `MEMORY.md auto-compressed (${(memory.charCount / 1024).toFixed(0)}KB -> ${(afterMemory.charCount / 1024).toFixed(0)}KB)`,
                );
            }
            if (user.charCount > user.threshold) {
                logs.push(
                    `USER.md auto-compressed (${(user.charCount / 1024).toFixed(0)}KB -> ${(afterUser.charCount / 1024).toFixed(0)}KB)`,
                );
            }
        }

        return logs;
    }
}
