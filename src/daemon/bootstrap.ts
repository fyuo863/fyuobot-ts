import process from "process";
import { HistoryManager } from "../memory/history-manager.js";
import { resolveProjectRoot } from "../config/agent-paths.js";
import { spawnIsolatedJobRunner } from "./job-runner.js";
import {
    SchedulerDaemonLock,
    SchedulerDaemonService,
    SchedulerRepository,
} from "../scheduler/service.js";

interface DaemonBootstrapOptions {
    mcpServers: Array<unknown>;
}

export async function bootstrapDaemon(
    options: DaemonBootstrapOptions,
): Promise<void> {
    const projectRoot = resolveProjectRoot();
    HistoryManager.init(projectRoot);

    const repository = new SchedulerRepository(projectRoot);
    const lock = new SchedulerDaemonLock(repository);
    let daemon: SchedulerDaemonService | undefined;

    try {
        lock.acquire();
        repository.appendDaemonLog(`lock acquired for project ${projectRoot}`);
        daemon = new SchedulerDaemonService({
            repository,
            executeJob: (job, trigger) => spawnIsolatedJobRunner(job, trigger),
        });

        console.log(`[daemon] project root: ${projectRoot}`);
        if (options.mcpServers.length > 0) {
            console.log(`[daemon] MCP config entries: ${options.mcpServers.length}`);
            repository.appendDaemonLog(
                `MCP config entries loaded: ${options.mcpServers.length}`,
            );
        }
        console.log("[daemon] scheduler daemon started");
        repository.appendDaemonLog("bootstrap completed");

        await daemon.start();

        const cleanup = async () => {
            console.log("[daemon] shutting down");
            repository.appendDaemonLog("shutdown signal received");
            await daemon?.stop().catch(() => {});
            lock.release();
            repository.appendDaemonLog("lock released");
            process.exit(0);
        };

        process.on("SIGINT", () => {
            void cleanup();
        });
        process.on("SIGTERM", () => {
            void cleanup();
        });

        await new Promise<void>(() => {});
    } catch (error) {
        repository.appendDaemonLog(
            `bootstrap failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        await daemon?.stop().catch(() => {});
        lock.release();
        throw error;
    }
}
