import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ExternalToolRuntimeConfig {
    hideOutput?: boolean;
    force?: boolean;
}

export function loadExternalToolRuntimeConfig(
    toolDir: string,
): ExternalToolRuntimeConfig {
    const configPath = join(toolDir, "config.json");
    if (!existsSync(configPath)) return {};

    try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const config: ExternalToolRuntimeConfig = {};

        if (typeof parsed.hideOutput === "boolean") {
            config.hideOutput = parsed.hideOutput;
        }
        if (typeof parsed.force === "boolean") {
            config.force = parsed.force;
        }

        return config;
    } catch {
        return {};
    }
}
