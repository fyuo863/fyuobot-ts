import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { resolveProjectRoot } from "../config/agent-paths.js";
import {
    SchedulerRepository,
    inspectSchedulerRuntime,
    isProcessRunning,
} from "../scheduler/service.js";

function resolveDaemonEntry(projectRoot: string): {
    tsxPath: string;
    entryPath: string;
} {
    return {
        tsxPath: join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        entryPath: join(projectRoot, "src", "tui", "index.tsx"),
    };
}

function findSchedulerDaemonPids(projectRoot: string): number[] {
    const marker = join(projectRoot, "src", "tui", "index.tsx");
    if (process.platform === "win32") {
        const escapedMarker = marker.replace(/'/g, "''");
        const command = [
            "$items = Get-CimInstance Win32_Process | Where-Object {",
            "$_.CommandLine -and",
            `$_.CommandLine -like '*${escapedMarker}*' -and`,
            "$_.CommandLine -like '*--daemon*'",
            "}",
            "$items | Select-Object -ExpandProperty ProcessId",
        ].join(" ");
        const result = spawnSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", command],
            { encoding: "utf-8", windowsHide: true },
        );
        return String(result.stdout ?? "")
            .split(/\r?\n/)
            .map((line) => Number(line.trim()))
            .filter((pid) => Number.isFinite(pid) && pid > 0);
    }

    const result = spawnSync("ps", ["-eo", "pid=,args="], {
        encoding: "utf-8",
    });
    return String(result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes(marker) && line.includes("--daemon"))
        .map((line) => Number(line.split(/\s+/, 1)[0]))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
}

export function startSchedulerDaemon(
    projectRoot = resolveProjectRoot(),
): { ok: boolean; message: string } {
    projectRoot = resolveProjectRoot(projectRoot);
    const runtime = inspectSchedulerRuntime(projectRoot);
    const fallbackPids = findSchedulerDaemonPids(projectRoot);
    if (runtime.daemonRunning || fallbackPids.length > 0) {
        return {
            ok: true,
            message: `daemon 已在运行 (pid=${runtime.daemonPid ?? fallbackPids[0] ?? "unknown"})`,
        };
    }
    if (!runtime.canSpawnJobRunner) {
        return {
            ok: false,
            message: "缺少 tsx CLI 或任务执行入口，无法启动 daemon。",
        };
    }

    const { tsxPath, entryPath } = resolveDaemonEntry(projectRoot);
    const isWindows = process.platform === "win32";
    try {
        const child = spawn(
            process.execPath,
            [tsxPath, entryPath, "--daemon"],
            {
                stdio: "ignore",
                cwd: projectRoot,
                env: process.env,
                detached: true,
                windowsHide: isWindows,
            },
        );
        child.unref();

        return {
            ok: true,
            message: "daemon 启动请求已发送。",
        };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

export function ensureSchedulerDaemon(
    projectRoot = resolveProjectRoot(),
): { ok: boolean; message: string; started: boolean } {
    projectRoot = resolveProjectRoot(projectRoot);
    const runtime = inspectSchedulerRuntime(projectRoot);
    const fallbackPids = findSchedulerDaemonPids(projectRoot);
    if (runtime.daemonRunning || fallbackPids.length > 0) {
        return {
            ok: true,
            started: false,
            message: `daemon 已在运行 (pid=${runtime.daemonPid ?? fallbackPids[0] ?? "unknown"})`,
        };
    }
    const result = startSchedulerDaemon(projectRoot);
    return {
        ...result,
        started: result.ok,
    };
}

export function stopSchedulerDaemon(
    projectRoot = resolveProjectRoot(),
): { ok: boolean; message: string } {
    projectRoot = resolveProjectRoot(projectRoot);
    const repository = new SchedulerRepository(projectRoot);
    const runtime = inspectSchedulerRuntime(projectRoot);
    const fallbackPids = findSchedulerDaemonPids(projectRoot);
    if (!runtime.lockExists && fallbackPids.length === 0) {
        return { ok: true, message: "daemon 未运行。" };
    }

    const targetPids = runtime.daemonPid !== null
        ? [runtime.daemonPid]
        : fallbackPids;

    if (targetPids.length === 0) {
        repository.removeLockFile();
        return {
            ok: true,
            message: "lock 文件已清理，但未找到 daemon 进程。",
        };
    }

    for (const pid of targetPids) {
        try {
            process.kill(pid, "SIGTERM");
        } catch (error) {
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                (error as { code?: string }).code === "ESRCH"
            ) {
                continue;
            }
            return {
                ok: false,
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    return {
        ok: true,
        message: `已向 daemon 进程发送终止信号 (pid=${targetPids.join(",")})。`,
    };
}

export function restartSchedulerDaemon(
    projectRoot = resolveProjectRoot(),
): { ok: boolean; message: string } {
    projectRoot = resolveProjectRoot(projectRoot);
    const stopResult = stopSchedulerDaemon(projectRoot);
    if (!stopResult.ok) {
        return stopResult;
    }
    return startSchedulerDaemon(projectRoot);
}

export async function restartSchedulerDaemonAndWait(
    projectRoot = resolveProjectRoot(),
    options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ ok: boolean; message: string }> {
    projectRoot = resolveProjectRoot(projectRoot);
    const timeoutMs = options.timeoutMs ?? 5000;
    const pollMs = options.pollMs ?? 150;
    const runtime = inspectSchedulerRuntime(projectRoot);
    const pid = runtime.daemonPid;

    const stopResult = stopSchedulerDaemon(projectRoot);
    if (!stopResult.ok) {
        return stopResult;
    }

    if (pid !== null) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (!isProcessRunning(pid)) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
    }

    return startSchedulerDaemon(projectRoot);
}
