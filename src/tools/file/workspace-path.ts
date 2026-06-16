import { isAbsolute, relative, resolve } from "node:path";

function asBoolean(value: unknown): boolean {
    return value === true || value === "true";
}

export function parseAllowOutsideWorkspace(value: unknown): boolean {
    return asBoolean(value);
}

export function resolveWorkspacePath(
    filePath: string,
    allowOutsideWorkspace: boolean,
): string {
    const workspaceRoot = process.cwd();
    const absolutePath = isAbsolute(filePath)
        ? resolve(filePath)
        : resolve(workspaceRoot, filePath);

    if (allowOutsideWorkspace) {
        return absolutePath;
    }

    const rel = relative(workspaceRoot, absolutePath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
            `Path is outside workspace. Pass allow_outside_workspace=true only when explicitly intended: ${absolutePath}`,
        );
    }

    return absolutePath;
}
