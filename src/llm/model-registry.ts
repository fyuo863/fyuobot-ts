import OpenAI from "openai";
import { loadAppConfig } from "../config/app-config.js";

export interface ModelProviderConfig {
    baseURL?: string;
    apiKey?: string;
    provider?: string;
}

export interface ModelDefinition extends ModelProviderConfig {
    id: string;
    model: string;
    description?: string;
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

        result.push({
            id,
            model,
            ...(baseURL ? { baseURL } : {}),
            ...(apiKey ? { apiKey } : {}),
            ...(provider ? { provider } : {}),
            ...(description ? { description } : {}),
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

export function createClientForModel(modelOrId?: string): OpenAI {
    const resolved = resolveModelConfig(modelOrId);
    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
        apiKey: resolved.apiKey,
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
    };
    return new OpenAI(clientOptions);
}
