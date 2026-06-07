import { exec, spawn } from "node:child_process";
import * as os from "node:os";
import { isAbsolute, resolve } from "node:path";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 80_000;
const MAX_OUTPUT_CHARS = 500_000;

function asBoolean(value: unknown): boolean {
    return value === true || value === "true";
}

function asNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function truncateOutput(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function resolveCwd(cwd: unknown): string {
    if (typeof cwd !== "string" || cwd.trim() === "") {
        return process.cwd();
    }
    return isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
}

function windowsPowerShellCommand(command: string): string {
    const psCommand = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "$OutputEncoding = [System.Text.Encoding]::UTF8",
        command,
    ].join("; ");
    const encoded = Buffer.from(psCommand, "utf16le").toString("base64");
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

export class ShellTool extends BaseTool {
    name = "execute_command";

    get description() {
        const isWin = os.platform() === "win32";
        const shellName = isWin ? "Windows PowerShell" : "Bash/sh";
        return [
            `Execute a ${shellName} command on the host machine.`,
            "Use cwd for project-relative commands, timeout_ms for long tasks, and ignore=true only for intentional background processes.",
            "Output is captured, UTF-8 normalized on Windows, and truncated to max_output_chars.",
        ].join("\n");
    }

    readonly dangerous = true;
    readonly concurrencyKey = "execute_command";

    parameters: ToolParam[] = [
        {
            name: "command",
            type: "string",
            description: "Command to execute.",
            required: true,
        },
        {
            name: "cwd",
            type: "string",
            description: "Working directory. Relative paths resolve from process.cwd().",
            required: false,
        },
        {
            name: "timeout_ms",
            type: "number",
            description: "Timeout in milliseconds. Defaults to 30000, max 600000.",
            required: false,
        },
        {
            name: "max_output_chars",
            type: "number",
            description: "Maximum stdout/stderr characters returned. Defaults to 80000.",
            required: false,
        },
        {
            name: "ignore",
            type: "boolean",
            description: "Run in the background and return immediately without captured output.",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const command = String(args.command ?? "").trim();
        if (!command) return "Command execution failed: missing command.";

        const cwd = resolveCwd(args.cwd);
        const timeoutMs = clamp(
            asNumber(args.timeout_ms, DEFAULT_TIMEOUT_MS),
            1_000,
            MAX_TIMEOUT_MS,
        );
        const maxOutputChars = clamp(
            asNumber(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS),
            1_000,
            MAX_OUTPUT_CHARS,
        );
        const isWindows = os.platform() === "win32";
        const finalCommand = isWindows ? windowsPowerShellCommand(command) : command;

        if (asBoolean(args.ignore)) {
            return this.runBackground(finalCommand, command, cwd, isWindows);
        }

        return await this.runForeground(
            finalCommand,
            command,
            cwd,
            timeoutMs,
            maxOutputChars,
            isWindows,
        );
    }

    private runBackground(
        finalCommand: string,
        originalCommand: string,
        cwd: string,
        isWindows: boolean,
    ): string {
        const child = isWindows
            ? spawn("cmd.exe", ["/d", "/s", "/c", finalCommand], {
                  cwd,
                  detached: true,
                  stdio: "ignore",
                  windowsHide: true,
              })
            : spawn("/bin/sh", ["-c", originalCommand], {
                  cwd,
                  detached: true,
                  stdio: "ignore",
              });

        child.unref();
        return [
            "Command started in background.",
            `pid: ${child.pid ?? "unknown"}`,
            `cwd: ${cwd}`,
            `command: ${originalCommand}`,
        ].join("\n");
    }

    private runForeground(
        finalCommand: string,
        originalCommand: string,
        cwd: string,
        timeoutMs: number,
        maxOutputChars: number,
        isWindows: boolean,
    ): Promise<string> {
        return new Promise((resolveResult) => {
            const startedAt = Date.now();
            const child = exec(finalCommand, {
                cwd,
                timeout: timeoutMs,
                maxBuffer: Math.max(maxOutputChars * 4, 1024 * 1024),
                windowsHide: isWindows,
                env: isWindows
                    ? { ...process.env, PYTHONIOENCODING: "utf-8" }
                    : process.env,
            });

            let stdout = "";
            let stderr = "";

            child.stdout?.on("data", (chunk: Buffer | string) => {
                stdout += chunk.toString();
            });
            child.stderr?.on("data", (chunk: Buffer | string) => {
                stderr += chunk.toString();
            });

            child.on("error", (error) => {
                resolveResult(`Command execution failed before start: ${error.message}`);
            });

            child.on("close", (code, signal) => {
                const elapsedMs = Date.now() - startedAt;
                const timedOut = signal === "SIGTERM" && elapsedMs >= timeoutMs;
                const status =
                    code === 0
                        ? "succeeded"
                        : timedOut
                          ? "timed out"
                          : "failed";

                const parts = [
                    `Command ${status}.`,
                    `cwd: ${cwd}`,
                    `exit_code: ${code ?? "null"}`,
                    `signal: ${signal ?? "null"}`,
                    `elapsed_ms: ${elapsedMs}`,
                    `command: ${originalCommand}`,
                    "",
                    "[stdout]",
                    truncateOutput(stdout || "", maxOutputChars),
                    "",
                    "[stderr]",
                    truncateOutput(stderr || "", maxOutputChars),
                ];

                resolveResult(parts.join("\n").trimEnd());
            });
        });
    }
}
