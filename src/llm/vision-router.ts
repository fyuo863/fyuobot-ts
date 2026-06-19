import OpenAI from "openai";
import {
    createClientForModel,
    resolveModelConfig,
    resolveVisionModelFor,
    modelSupportsVision,
} from "./model-registry.js";

export interface ImageAttachment {
    name?: string;
    mimeType: string;
    dataUrl: string;
    sizeBytes?: number;
}

export interface VisionUnderstandingResult {
    requestedModelId?: string;
    visionModelId: string;
    visionModelName: string;
    usedFallback: boolean;
    attachments: Array<{
        name?: string;
        mimeType: string;
        sizeBytes?: number;
    }>;
    summary: string;
    raw: string;
}

function buildVisionMessages(
    userText: string,
    attachments: ImageAttachment[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        {
            type: "text",
            text: [
                "请只做图片理解，不要调用工具，不要假设用户未提供的信息。",
                "输出使用以下结构：",
                "1. summary: 一段简洁总结",
                "2. ocr_text: 能识别到的重要文字",
                "3. key_objects: 关键对象/界面元素",
                "4. issues_or_signals: 错误、警告、异常、值得关注之处",
                "5. suggested_next_steps: 建议主模型后续怎么处理",
                "",
                "用户补充文本：",
                userText || "无",
            ].join("\n"),
        },
    ];

    for (const attachment of attachments) {
        content.push({
            type: "image_url",
            image_url: {
                url: attachment.dataUrl,
            },
        });
    }

    return [
        {
            role: "user",
            content,
        },
    ];
}

export function hasImageAttachments(
    attachments: ImageAttachment[] | undefined,
): attachments is ImageAttachment[] {
    return Array.isArray(attachments) && attachments.length > 0;
}

export async function understandImagesForModel(
    userText: string,
    attachments: ImageAttachment[],
    requestedModelId?: string,
): Promise<VisionUnderstandingResult> {
    const visionModelId = resolveVisionModelFor(requestedModelId);
    if (!visionModelId) {
        throw new Error("当前未配置支持识图的模型，也未找到视觉回退模型。");
    }

    const resolvedVisionModel = resolveModelConfig(visionModelId);
    const client = createClientForModel(visionModelId);
    const usedFallback =
        !!requestedModelId &&
        resolveModelConfig(requestedModelId).id !== resolvedVisionModel.id &&
        !modelSupportsVision(requestedModelId);

    const response = await client.chat.completions.create({
        model: resolvedVisionModel.model,
        messages: buildVisionMessages(userText, attachments),
        temperature: 0.2,
        stream: false,
    });

    const raw =
        response.choices[0]?.message?.content?.trim() ||
        "未能从视觉模型获得有效结果。";

    const summary = [
        `[视觉预处理] 使用模型: ${resolvedVisionModel.id} (${resolvedVisionModel.model})`,
        usedFallback
            ? `[视觉预处理] 主模型不支持识图，已自动回退到视觉模型。`
            : `[视觉预处理] 当前模型直接支持识图。`,
        "",
        raw,
    ].join("\n");

    return {
        visionModelId: resolvedVisionModel.id,
        visionModelName: resolvedVisionModel.model,
        usedFallback,
        ...(requestedModelId ? { requestedModelId } : {}),
        attachments: attachments.map((item) => ({
            ...(item.name ? { name: item.name } : {}),
            mimeType: item.mimeType,
            ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
        })),
        summary,
        raw,
    };
}
