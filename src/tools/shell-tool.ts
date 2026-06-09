import { spawn } from "node:child_process";
import * as os from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
    hostCommandEnv,
    hostShellLabel,
    selectHostShell,
    type HostShell,
} from "../utils/host-shell.js";
import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 80_000;
const MAX_OUTPUT_CHARS = 500_000;

interface CapturedOutput {
    value: string;
    truncatedChars: number;
}

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

function createCapturedOutput(): CapturedOutput {
    return { value: "", truncatedChars: 0 };
}

function appendCapturedOutput(
    output: CapturedOutput,
    chunk: Buffer | string,
    maxChars: number,
): void {
    const text = chunk.toString();
    const remaining = maxChars - output.value.length;

    if (remaining > 0) {
        output.value += text.slice(0, remaining);
    }

    if (text.length > remaining) {
        output.truncatedChars += text.length - Math.max(remaining, 0);
    }
}

function formatCapturedOutput(output: CapturedOutput): string {
    if (output.truncatedChars === 0) return output.value;
    return `${output.value}\n[truncated ${output.truncatedChars} chars]`;
}

function resolveCwd(cwd: unknown): string {
    if (typeof cwd !== "string" || cwd.trim() === "") {
        return process.cwd();
    }
    return isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
}

export class ShellTool extends BaseTool {
    name = "execute_command";

    get description() {
        const shellName = selectHostShell().name;
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
        const shell = selectHostShell();

        if (asBoolean(args.ignore)) {
            return this.runBackground(shell, command, cwd, isWindows);
        }

        return await this.runForeground(
            shell,
            command,
            cwd,
            timeoutMs,
            maxOutputChars,
            isWindows,
        );
    }

    private runBackground(
        shell: HostShell,
        originalCommand: string,
        cwd: string,
        isWindows: boolean,
    ): string {
        const child = spawn(shell.command, shell.args(originalCommand), {
            cwd,
            detached: true,
            stdio: "ignore",
            windowsHide: isWindows,
            env: hostCommandEnv(isWindows),
        });

        child.unref();
        return [
            "Command started in background.",
            `pid: ${child.pid ?? "unknown"}`,
            `cwd: ${cwd}`,
            `shell: ${hostShellLabel(shell)}`,
            `command: ${originalCommand}`,
        ].join("\n");
    }

    private runForeground(
        shell: HostShell,
        originalCommand: string,
        cwd: string,
        timeoutMs: number,
        maxOutputChars: number,
        isWindows: boolean,
    ): Promise<string> {
        return new Promise((resolveResult) => {
            const startedAt = Date.now();
            const child = spawn(shell.command, shell.args(originalCommand), {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: isWindows,
                env: hostCommandEnv(isWindows),
            });

            const stdout = createCapturedOutput();
            const stderr = createCapturedOutput();
            let timedOut = false;
            let settled = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                child.kill();
            }, timeoutMs);

            const resolveOnce = (value: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolveResult(value);
            };

            child.stdout?.on("data", (chunk: Buffer | string) => {
                appendCapturedOutput(stdout, chunk, maxOutputChars);
            });
            child.stderr?.on("data", (chunk: Buffer | string) => {
                appendCapturedOutput(stderr, chunk, maxOutputChars);
            });

            child.on("error", (error) => {
                resolveOnce(`Command execution failed before start: ${error.message}`);
            });

            child.on("close", (code, signal) => {
                const elapsedMs = Date.now() - startedAt;
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
                    `shell: ${hostShellLabel(shell)}`,
                    `command: ${originalCommand}`,
                    "",
                    "[stdout]",
                    formatCapturedOutput(stdout),
                    "",
                    "[stderr]",
                    formatCapturedOutput(stderr),
                ];

                resolveOnce(parts.join("\n").trimEnd());
            });
        });
    }
}
