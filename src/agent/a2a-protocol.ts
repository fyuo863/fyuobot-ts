import type { AgentMessageChannel, AgentMessageEnvelope, AgentMessageRole } from "./events.js";

export const A2A_PROTOCOL_VERSION = "a2a.v1";

export type A2AOperation = "create" | "send" | "list" | "delete";

export interface A2AAgentDescriptor {
    agentId: string;
    agentName: string;
    persistent: boolean;
    model?: string;
    allowedTools: string[];
}

export interface A2ARequest {
    protocolVersion: typeof A2A_PROTOCOL_VERSION;
    operation: A2AOperation;
    requestId: string;
    sourceAgentId: string;
    sourceAgentName: string;
    targetAgentId?: string;
    targetAgentName?: string;
    message?: string;
    context?: string;
    model?: string;
    allowedTools?: string[];
}

export interface A2AResponse {
    protocolVersion: typeof A2A_PROTOCOL_VERSION;
    requestId: string;
    ok: boolean;
    agent?: A2AAgentDescriptor;
    content?: string;
    error?: string;
}

export function createA2ARequest(
    input: Omit<A2ARequest, "protocolVersion" | "requestId"> & {
        requestId?: string;
    },
): A2ARequest {
    const timestamp = Date.now();
    return {
        protocolVersion: A2A_PROTOCOL_VERSION,
        requestId:
            input.requestId ??
            `a2a_req_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
        ...input,
    };
}

export function createAgentMessageEnvelope(input: {
    conversationId: string;
    turnId: string;
    sourceAgentId: string;
    sourceAgentName: string;
    role: AgentMessageRole;
    channel: AgentMessageChannel;
    content: string;
    targetAgentId?: string;
    targetAgentName?: string;
    timestamp?: number;
    messageId?: string;
}): AgentMessageEnvelope {
    const timestamp = input.timestamp ?? Date.now();
    return {
        protocolVersion: A2A_PROTOCOL_VERSION,
        messageId:
            input.messageId ??
            `a2a_msg_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
        conversationId: input.conversationId,
        turnId: input.turnId,
        sourceAgentId: input.sourceAgentId,
        sourceAgentName: input.sourceAgentName,
        ...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
        ...(input.targetAgentName ? { targetAgentName: input.targetAgentName } : {}),
        role: input.role,
        channel: input.channel,
        content: input.content,
        timestamp,
    };
}
