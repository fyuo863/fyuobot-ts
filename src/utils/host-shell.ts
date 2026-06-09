import { existsSync } from "node:fs";
import * as os from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface HostShell {
    name: string;
    command: string;
    args(command: string): string[];
}

function windowsPowerShellArgs(command: string): string[] {
    const psCommand = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "$OutputEncoding = [System.Text.Encoding]::UTF8",
        command,
    ].join("; ");
    const encoded = Buffer.from(psCommand, "utf16le").toString("base64");
    return [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
    ];
}

function loginShellArgs(command: string): string[] {
    return ["-lc", command];
}

function shArgs(command: string): string[] {
    return ["-c", command];
}

function getPathEnv(): string {
    const pathEntry = Object.entries(process.env).find(
        ([key]) => key.toLowerCase() === "path",
    );
    return pathEntry?.[1] ?? "";
}

function commandExists(command: string, platform: NodeJS.Platform): boolean {
    if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
        return existsSync(command);
    }

    const pathEntries = getPathEnv().split(delimiter).filter(Boolean);
    const names =
        platform === "win32"
            ? [
                  command,
                  ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
                      .split(";")
                      .filter(Boolean)
                      .map((ext) =>
                          command.toLowerCase().endsWith(ext.toLowerCase())
                              ? command
                              : `${command}${ext}`,
                      ),
              ]
            : [command];

    for (const dir of pathEntries) {
        for (const name of new Set(names)) {
            if (existsSync(join(dir, name))) return true;
        }
    }

    return false;
}

function getShellCandidates(platform: NodeJS.Platform): HostShell[] {
    if (platform === "win32") {
        const systemPowerShell = process.env.SystemRoot
            ? join(
                  process.env.SystemRoot,
                  "System32",
                  "WindowsPowerShell",
                  "v1.0",
                  "powershell.exe",
              )
            : "powershell.exe";

        return [
            {
                name: "PowerShell 7",
                command: "pwsh.exe",
                args: windowsPowerShellArgs,
            },
            {
                name: "Windows PowerShell",
                command: systemPowerShell,
                args: windowsPowerShellArgs,
            },
            {
                name: "Windows PowerShell",
                command: "powershell.exe",
                args: windowsPowerShellArgs,
            },
        ];
    }

    if (platform === "darwin") {
        return [
            { name: "Zsh", command: "/bin/zsh", args: loginShellArgs },
            { name: "Bash", command: "/bin/bash", args: loginShellArgs },
            { name: "sh", command: "/bin/sh", args: shArgs },
        ];
    }

    return [
        { name: "Bash", command: "/bin/bash", args: loginShellArgs },
        { name: "Bash", command: "/usr/bin/bash", args: loginShellArgs },
        { name: "sh", command: "/bin/sh", args: shArgs },
    ];
}

function quotePowerShellArg(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function quotePosixArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

export function selectHostShell(
    platform: NodeJS.Platform = os.platform(),
): HostShell {
    const candidates = getShellCandidates(platform);
    return (
        candidates.find((candidate) => commandExists(candidate.command, platform)) ??
        candidates[candidates.length - 1]!
    );
}

export function hostShellLabel(shell: HostShell): string {
    return `${shell.name} (${shell.command})`;
}

export function hostCommandEnv(isWindows = os.platform() === "win32"): NodeJS.ProcessEnv {
    return isWindows
        ? { ...process.env, PYTHONIOENCODING: "utf-8" }
        : process.env;
}

export function buildHostShellCommand(
    command: string,
    args: readonly string[] = [],
    platform: NodeJS.Platform = os.platform(),
): string {
    if (platform === "win32") {
        return ["&", quotePowerShellArg(command), ...args.map(quotePowerShellArg)].join(
            " ",
        );
    }

    return [quotePosixArg(command), ...args.map(quotePosixArg)].join(" ");
}
