import { existsSync } from "fs";
import { resolveProjectRoot } from "../config/agent-paths.js";
import { SchedulerRepository } from "../scheduler/service.js";

export function shouldAutoStartDaemon(argv: string[]): boolean {
    if (argv.includes("--daemon")) return false;
    if (argv.includes("--run-scheduled-job")) return false;
    if (argv.includes("--no-daemon")) return false;

    const projectRoot = resolveProjectRoot();
    const repository = new SchedulerRepository(projectRoot);
    const jobs = repository.loadJobs();
    if (jobs.length === 0) return false;

    const lockExists = existsSync(repository.getLockPath());
    return !lockExists;
}
