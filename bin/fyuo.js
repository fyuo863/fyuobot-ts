#!/usr/bin/env node

/**
 * fyuobot CLI entry point
 *
 * Uses the project's local tsx to run the TypeScript source directly,
 * so source changes are reflected immediately without recompilation.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tsxPath = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entryPath = join(root, "src", "tui", "index.tsx");
const argv = process.argv.slice(2);
const isWindows = process.platform === "win32";

function getSchedulerCodeMtimeMs() {
    const files = [
        join(root, "src", "scheduler", "service.ts"),
        join(root, "src", "daemon", "bootstrap.ts"),
        join(root, "src", "daemon", "job-runner.ts"),
        join(root, "src", "daemon", "run-job.ts"),
        join(root, "src", "daemon", "daemon-control.ts"),
        join(root, "src", "tui", "index.tsx"),
    ];
    let latest = 0;
    for (const file of files) {
        try {
            latest = Math.max(latest, statSync(file).mtimeMs);
        } catch {
            // ignore
        }
    }
    return latest;
}

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && typeof error === "object" && error.code === "EPERM";
    }
}

function findSchedulerDaemonPids() {
    const marker = entryPath;
    if (isWindows) {
        const escapedMarker = marker.replace(/'/g, "''");
        const command = [
            "$items = Get-CimInstance Win32_Process | Where-Object {",
            "$_.CommandLine -and",
            `$_.CommandLine -like '*${escapedMarker}*' -and`,
            "$_.CommandLine -like '*--daemon*'",
            "}",
            "$items | Select-Object -ExpandProperty ProcessId",
        ].join(" ");
        const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            stdio: ["ignore", "pipe", "ignore"],
            cwd: root,
            env: process.env,
            windowsHide: true,
        });
        return new Promise((resolve) => {
            let stdout = "";
            result.stdout?.on("data", (chunk) => {
                stdout += chunk.toString();
            });
            result.on("close", () => {
                resolve(
                    stdout
                        .split(/\r?\n/)
                        .map((line) => Number(line.trim()))
                        .filter((pid) => Number.isFinite(pid) && pid > 0),
                );
            });
        });
    }

    const result = spawn("ps", ["-eo", "pid=,args="], {
        stdio: ["ignore", "pipe", "ignore"],
        cwd: root,
        env: process.env,
    });
    return new Promise((resolve) => {
        let stdout = "";
        result.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        result.on("close", () => {
            resolve(
                stdout
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line.includes(marker) && line.includes("--daemon"))
                    .map((line) => Number(line.split(/\s+/, 1)[0]))
                    .filter((pid) => Number.isFinite(pid) && pid > 0),
            );
        });
    });
}

function readDaemonLockInfo() {
    const lockPath = join(root, ".fyuobot", "schedules", "daemon.lock");
    if (!existsSync(lockPath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(lockPath, "utf-8"));
    } catch {
        return null;
    }
}

function daemonNeedsRestartForCodeUpdate() {
    const info = readDaemonLockInfo();
    if (!info || typeof info.pid !== "number") {
        return false;
    }
    if (!isProcessRunning(info.pid)) {
        return false;
    }
    const currentCodeMtimeMs = getSchedulerCodeMtimeMs();
    const daemonCodeMtimeMs =
        typeof info.codeMtimeMs === "number"
            ? info.codeMtimeMs
            : typeof info.startedAt === "number"
              ? info.startedAt
              : 0;
    return currentCodeMtimeMs > daemonCodeMtimeMs + 1;
}

function shouldAutoStartDaemon(argv) {
    if (argv.includes("--daemon")) return false;
    if (argv.includes("--run-scheduled-job")) return false;
    if (argv.includes("--no-daemon")) return false;

    const schedulesDir = join(root, ".fyuobot", "schedules");
    const jobsPath = join(schedulesDir, "jobs.json");
    const lockPath = join(schedulesDir, "daemon.lock");

    if (!existsSync(jobsPath)) {
        return false;
    }

    try {
        const raw = JSON.parse(readFileSync(jobsPath, "utf-8"));
        const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
        if (jobs.length === 0) {
            return false;
        }
    } catch {
        return false;
    }

    if (!existsSync(lockPath)) {
        return true;
    }

    const info = readDaemonLockInfo();
    if (!info || typeof info.pid !== "number") {
        try {
            unlinkSync(lockPath);
        } catch {
            // ignore
        }
        return true;
    }

    if (!isProcessRunning(info.pid)) {
        try {
            unlinkSync(lockPath);
        } catch {
            // ignore
        }
        return true;
    }

    return false;
}

function spawnDaemon() {
    const daemon = spawn(process.execPath, [tsxPath, entryPath, "--daemon"], {
        stdio: "ignore",
        cwd: root,
        env: process.env,
        detached: true,
        windowsHide: isWindows,
    });
    daemon.unref();
}

function stopDaemonIfRunning() {
    const info = readDaemonLockInfo();
    if (info && typeof info.pid === "number") {
        try {
            process.kill(info.pid, "SIGTERM");
        } catch {
            // best-effort only
        }
    }
}

async function waitForDaemonExit(timeoutMs = 5000, pollMs = 150) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const info = readDaemonLockInfo();
        if (!info || typeof info.pid !== "number") {
            return;
        }
        if (!isProcessRunning(info.pid)) {
            try {
                unlinkSync(join(root, ".fyuobot", "schedules", "daemon.lock"));
            } catch {
                // ignore
            }
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

if (daemonNeedsRestartForCodeUpdate()) {
    try {
        stopDaemonIfRunning();
        await waitForDaemonExit();
    } catch {
        // best-effort only
    }
}

if (!daemonNeedsRestartForCodeUpdate()) {
    const fallbackPids = await findSchedulerDaemonPids();
    if (fallbackPids.length > 0 && !readDaemonLockInfo()) {
        for (const pid of fallbackPids) {
            try {
                process.kill(pid, "SIGTERM");
            } catch {
                // ignore
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
    }
}

if (shouldAutoStartDaemon(argv) || daemonNeedsRestartForCodeUpdate()) {
    try {
        spawnDaemon();
    } catch {
        // auto-start daemon is best-effort only
    }
}

const child = spawn(process.execPath, [tsxPath, entryPath, ...argv], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
});

child.on("close", (code) => {
    process.exit(code ?? 0);
});
