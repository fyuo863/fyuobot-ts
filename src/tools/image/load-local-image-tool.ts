import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { appendTurnAttachments } from "../../agent/turn-attachments.js";
import { type ImageAttachment } from "../../llm/vision-router.js";
import { BaseTool, type ToolParam } from "../basetool.js";
import {
    parseAllowOutsideWorkspace,
    resolveWorkspacePath,
} from "../file/workspace-path.js";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
};

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function resolveImageMimeType(filePath: string): string | null {
    return IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()] ?? null;
}

export class LoadLocalImageTool extends BaseTool {
    name = "load_local_image";

    description = [
        "读取本地图片文件，并将其挂载到当前对话轮次的图片附件上下文中。",
        "适用于用户仅提供本地图片路径时，让后续视觉子 Agent 能继续分析该图片。",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "path",
            type: "string",
            description: "要读取的本地图片绝对路径或工作区内相对路径。",
            required: true,
        },
        {
            name: "allow_outside_workspace",
            type: "boolean",
            description: "是否允许读取工作区外路径。默认 false，只有用户明确要求时才设 true。",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const rawPath =
            typeof args.path === "string" && args.path.trim()
                ? args.path.trim()
                : "";
        if (!rawPath) {
            return "错误：缺少 path 参数。";
        }

        const turnId =
            typeof args.__agent_turn_id === "string" && args.__agent_turn_id.trim()
                ? args.__agent_turn_id.trim()
                : "";
        if (!turnId) {
            return "错误：当前缺少 turn 上下文，无法挂载图片附件。";
        }

        const allowOutsideWorkspace = parseAllowOutsideWorkspace(
            args.allow_outside_workspace,
        );
        const absolutePath = resolveWorkspacePath(rawPath, allowOutsideWorkspace);
        const mimeType = resolveImageMimeType(absolutePath);
        if (!mimeType) {
            return `错误：不支持的图片类型，仅支持 ${Object.keys(IMAGE_MIME_BY_EXT).join(", ")}。`;
        }

        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
            return `错误：路径不是文件: ${absolutePath}`;
        }
        if (fileStat.size > MAX_IMAGE_BYTES) {
            return `错误：图片过大，当前仅支持不超过 ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB 的图片。`;
        }

        const buffer = await readFile(absolutePath);
        const attachment: ImageAttachment = {
            name: basename(absolutePath),
            mimeType,
            sizeBytes: buffer.byteLength,
            dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
        };
        const allAttachments = appendTurnAttachments(turnId, [attachment]);

        return [
            "已加载本地图片到当前对话附件上下文。",
            `路径: ${absolutePath}`,
            `文件名: ${attachment.name}`,
            `类型: ${attachment.mimeType}`,
            `大小: ${formatBytes(attachment.sizeBytes ?? 0)}`,
            `当前轮附件数: ${allAttachments.length}`,
            "你现在可以继续调用视觉子 Agent 分析这张图片。",
        ].join("\n");
    }
}
