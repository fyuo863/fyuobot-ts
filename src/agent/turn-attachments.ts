import type { ImageAttachment } from "../llm/vision-router.js";

const turnAttachmentStore = new Map<string, ImageAttachment[]>();

function dedupeAttachments(attachments: ImageAttachment[]): ImageAttachment[] {
    const seen = new Set<string>();
    const result: ImageAttachment[] = [];
    for (const attachment of attachments) {
        const key = [
            attachment.name ?? "",
            attachment.mimeType,
            attachment.sizeBytes ?? 0,
            attachment.dataUrl.slice(0, 128),
        ].join("|");
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push({ ...attachment });
    }
    return result;
}

export function setTurnAttachments(
    turnId: string,
    attachments: ImageAttachment[] | undefined,
): void {
    if (!turnId) {
        return;
    }
    if (!Array.isArray(attachments) || attachments.length === 0) {
        turnAttachmentStore.delete(turnId);
        return;
    }
    turnAttachmentStore.set(turnId, dedupeAttachments(attachments));
}

export function appendTurnAttachments(
    turnId: string,
    attachments: ImageAttachment[] | undefined,
): ImageAttachment[] {
    if (!turnId || !Array.isArray(attachments) || attachments.length === 0) {
        return getTurnAttachments(turnId);
    }
    const merged = dedupeAttachments([
        ...getTurnAttachments(turnId),
        ...attachments.map((attachment) => ({ ...attachment })),
    ]);
    turnAttachmentStore.set(turnId, merged);
    return merged.map((attachment) => ({ ...attachment }));
}

export function getTurnAttachments(turnId: string): ImageAttachment[] {
    if (!turnId) {
        return [];
    }
    const attachments = turnAttachmentStore.get(turnId);
    return Array.isArray(attachments)
        ? attachments.map((attachment) => ({ ...attachment }))
        : [];
}

export function clearTurnAttachments(turnId: string): void {
    if (!turnId) {
        return;
    }
    turnAttachmentStore.delete(turnId);
}
