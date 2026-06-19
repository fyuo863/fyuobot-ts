import OpenAI from "openai";
import { loadAppConfig } from "../config/app-config.js";

export interface ModelProviderConfig {
    baseURL?: string;
    apiKey?: string;
    provider?: string;
}

export interface ModelCapabilities {
    vision?: boolean;
    toolUse?: boolean;
    streaming?: boolean;
}

export interface ModelDefinition extends ModelProviderConfig {
    id: string;
    model: string;
    description?: string;
    capabilities?: ModelCapabilities;
}

export interface ResolvedModelConfig extends ModelDefinition {
    apiKey: string;
}

type RawModelDefinition = {
    model?: unknown;
    baseURL?: unknown;
    apiKey?: unknown;
    provider?: unknown;
    description?: unknown;
    capabilities?: unknown;
};

function toOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function resolveEnvPlaceholder(value: string | undefined): string | undefined {
    if (!value) return value;
    const matched = /^\$\{([A-Z0-9_]+)\}$/i.exec(value);
    if (!matched) return value;
    const envKey = matched[1];
    if (!envKey) return value;
    const envValue = process.env[envKey];
    return typeof envValue === "string" && envValue.trim()
        ? envValue.trim()
        : undefined;
}

function parseCapabilities(value: unknown): ModelCapabilities | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    const capabilities: ModelCapabilities = {};

    if (typeof raw.vision === "boolean") {
        capabilities.vision = raw.vision;
    }
    if (typeof raw.toolUse === "boolean") {
        capabilities.toolUse = raw.toolUse;
    }
    if (typeof raw.streaming === "boolean") {
        capabilities.streaming = raw.streaming;
    }
    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function parseConfiguredModels(): ModelDefinition[] {
    const { config } = loadAppConfig();
    const rawModels = config.models;
    if (!rawModels || typeof rawModels !== "object") {
        return [];
    }

    const result: ModelDefinition[] = [];
    for (const [id, rawValue] of Object.entries(rawModels)) {
        if (!rawValue || typeof rawValue !== "object") continue;
        const raw = rawValue as RawModelDefinition;
        const model = toOptionalString(raw.model);
        if (!model) continue;
        const baseURL = resolveEnvPlaceholder(toOptionalString(raw.baseURL));
        const apiKey = resolveEnvPlaceholder(toOptionalString(raw.apiKey));
        const provider = resolveEnvPlaceholder(toOptionalString(raw.provider));
        const description = resolveEnvPlaceholder(toOptionalString(raw.description));
        const capabilities = parseCapabilities(raw.capabilities);

        result.push({
            id,
            model,
            ...(baseURL ? { baseURL } : {}),
            ...(apiKey ? { apiKey } : {}),
            ...(provider ? { provider } : {}),
            ...(description ? { description } : {}),
            ...(capabilities ? { capabilities } : {}),
        });
    }

    return result;
}

function getLegacyDefaultModelDefinition(): ModelDefinition {
    return {
        id: "default",
        model: process.env.THIRD_PARTY_MODEL || "gpt-3.5-turbo",
        ...(process.env.THIRD_PARTY_BASE_URL
            ? { baseURL: process.env.THIRD_PARTY_BASE_URL }
            : {}),
        ...(process.env.THIRD_PARTY_API_KEY
            ? { apiKey: process.env.THIRD_PARTY_API_KEY }
            : {}),
    };
}

export function listConfiguredModels(): ModelDefinition[] {
    const configured = parseConfiguredModels();
    const byId = new Map<string, ModelDefinition>();

    for (const model of configured) {
        byId.set(model.id, model);
    }

    const legacyDefault = getLegacyDefaultModelDefinition();
    if (!byId.has(legacyDefault.id)) {
        byId.set(legacyDefault.id, legacyDefault);
    }

    return [...byId.values()];
}

export function getDefaultModelId(): string {
    const configuredDefault = loadAppConfig().config.defaultModel;
    if (
        typeof configuredDefault === "string" &&
        configuredDefault.trim() &&
        listConfiguredModels().some((model) => model.id === configuredDefault.trim())
    ) {
        return configuredDefault.trim();
    }
    return "default";
}

function resolveModelDefinition(modelOrId?: string): ModelDefinition {
    const configured = listConfiguredModels();

    if (modelOrId?.trim()) {
        const requested = modelOrId.trim();
        const matched = configured.find((entry) => entry.id === requested);
        if (matched) return matched;

        const defaultEntry = configured.find((entry) => entry.id === getDefaultModelId());
        const inherited = defaultEntry ?? getLegacyDefaultModelDefinition();
        return {
            id: requested,
            model: requested,
            ...(inherited.baseURL ? { baseURL: inherited.baseURL } : {}),
            ...(inherited.apiKey ? { apiKey: inherited.apiKey } : {}),
            ...(inherited.provider ? { provider: inherited.provider } : {}),
        };
    }

    const defaultId = getDefaultModelId();
    const defaultModel = configured.find((entry) => entry.id === defaultId);
    return defaultModel ?? getLegacyDefaultModelDefinition();
}

export function resolveModelConfig(modelOrId?: string): ResolvedModelConfig {
    const definition = resolveModelDefinition(modelOrId);
    const apiKey =
        resolveEnvPlaceholder(definition.apiKey?.trim()) ||
        process.env.THIRD_PARTY_API_KEY ||
        process.env.OPENAI_API_KEY ||
        "ollama";

    return {
        ...definition,
        apiKey,
    };
}

export function modelSupportsVision(modelOrId?: string): boolean {
    return resolveModelDefinition(modelOrId).capabilities?.vision === true;
}

export function getVisionFallbackModelId(): string | undefined {
    const configuredFallback = loadAppConfig().config.visionFallbackModel;
    if (
        typeof configuredFallback === "string" &&
        configuredFallback.trim() &&
        listConfiguredModels().some(
            (model) =>
                model.id === configuredFallback.trim() &&
                model.capabilities?.vision === true,
        )
    ) {
        return configuredFallback.trim();
    }

    const firstVisionModel = listConfiguredModels().find(
        (model) => model.capabilities?.vision === true,
    );
    return firstVisionModel?.id;
}

export function resolveVisionModelFor(modelOrId?: string): string | undefined {
    if (modelSupportsVision(modelOrId)) {
        return resolveModelDefinition(modelOrId).id;
    }
    return getVisionFallbackModelId();
}

export function createClientForModel(modelOrId?: string): OpenAI {
    const resolved = resolveModelConfig(modelOrId);
    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
        apiKey: resolved.apiKey,
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
    };
    return new OpenAI(clientOptions);
}
