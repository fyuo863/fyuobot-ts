import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { ToolRegistry } from "./basetool.js";
import type { BaseTool } from "./basetool.js";
import {
    loadSkillsFromDirectory,
    registerSkillsToRegistry,
} from "./skill/skill-loader.js";
import {
    getAgentPathCandidates,
    resolveGlobalAgentPath,
    resolveProjectAgentPath,
    resolveProjectRoot,
} from "../config/agent-paths.js";

export interface ToolLoadOptions {
    installExternalDependencies?: boolean;
    cacheBust?: string;
    mcpTools?: BaseTool[];
}

export interface ToolLoadResult {
    registry: ToolRegistry;
    builtInCount: number;
    externalCount: number;
    skillCount: number;
    mcpCount: number;
    watchedDirs: string[];
}

export function getToolWatchDirs(): string[] {
    return [
        fileURLToPath(new URL("./", import.meta.url)),
        ...getAgentPathCandidates("tools"),
        ...getAgentPathCandidates("skills"),
    ];
}

export async function loadToolRegistry(
    options: ToolLoadOptions = {},
): Promise<ToolLoadResult> {
    if (options.installExternalDependencies) {
        await installExternalToolDependencies();
    }

    const discoveryOptions =
        options.cacheBust !== undefined
            ? { cacheBust: options.cacheBust }
            : {};

    const registry = await ToolRegistry.discoverAndRegister(
        new URL("./", import.meta.url),
        discoveryOptions,
    );
    const builtInCount = registry.size;

    const externalDirs = getAgentPathCandidates("tools");
    let externalCount = 0;
    for (const dir of externalDirs) {
        if (!existsSync(dir)) continue;
        const extRegistry = await ToolRegistry.discoverFromFolders(
            pathToFileURL(dir),
            discoveryOptions,
        );
        externalCount += registry.mergeFrom(extRegistry);
    }

    const skillDirs = [
        join(
            dirname(fileURLToPath(import.meta.url)),
            "skill",
            "builtin",
        ),
        ...getAgentPathCandidates("skills"),
    ];
    let skillCount = 0;
    for (const dir of skillDirs) {
        const skillTools = await loadSkillsFromDirectory(dir);
        skillCount += registerSkillsToRegistry(registry, skillTools);
    }

    let mcpCount = 0;
    for (const tool of options.mcpTools ?? []) {
        try {
            registry.register(tool);
            mcpCount++;
        } catch {
            // Local tools keep precedence over duplicate MCP tool names.
        }
    }

    return {
        registry,
        builtInCount,
        externalCount,
        skillCount,
        mcpCount,
        watchedDirs: getToolWatchDirs().filter((dir) => existsSync(dir)),
    };
}

async function installExternalToolDependencies(): Promise<void> {
    const externalDirs: Array<{ dir: string; projectRoot?: string }> = [
        {
            dir: resolveProjectAgentPath("tools"),
            projectRoot: resolveProjectRoot(),
        },
        { dir: resolveGlobalAgentPath("tools") },
    ];

    for (const { dir, projectRoot } of externalDirs) {
        if (!existsSync(dir)) continue;
        const installed = await ToolRegistry.installDependencies(
            dir,
            projectRoot,
        );
        if (installed > 0) {
            console.log(`[tools] external dependencies processed: ${installed}`);
        }
    }
}
