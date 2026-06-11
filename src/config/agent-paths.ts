import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const AGENT_DIRNAME = ".fyuobot";

let cachedProjectRoot: string | undefined;

function hasAgentDir(dir: string): boolean {
    return existsSync(join(dir, AGENT_DIRNAME));
}

function findProjectRoot(startDir: string): string | undefined {
    let current = resolve(startDir);

    while (true) {
        if (hasAgentDir(current)) return current;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

export function resolveProjectRoot(startDir = process.cwd()): string {
    if (cachedProjectRoot) return cachedProjectRoot;
    cachedProjectRoot = findProjectRoot(startDir) ?? resolve(startDir);
    return cachedProjectRoot;
}

export function resolveAgentDir(startDir = process.cwd()): string {
    return join(resolveProjectRoot(startDir), AGENT_DIRNAME);
}

export function resolveProjectAgentPath(
    ...segments: string[]
): string {
    return join(resolveAgentDir(), ...segments);
}

export function resolveGlobalAgentPath(
    ...segments: string[]
): string {
    return join(homedir(), AGENT_DIRNAME, ...segments);
}

export function getAgentPathCandidates(
    ...segments: string[]
): string[] {
    const projectPath = resolveProjectAgentPath(...segments);
    const globalPath = resolveGlobalAgentPath(...segments);
    return projectPath === globalPath
        ? [projectPath]
        : [projectPath, globalPath];
}

export function resolveExistingAgentPath(
    ...segments: string[]
): string | undefined {
    return getAgentPathCandidates(...segments).find((candidate) =>
        existsSync(candidate),
    );
}
