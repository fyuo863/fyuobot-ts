import { spawn } from "child_process";
import { join } from "path";
import { resolveProjectRoot } from "../config/agent-paths.js";
import {
    SchedulerRepository,
    type ScheduledJob,
    type ScheduledJobPayload,
} from "../scheduler/service.js";

function encodeJob(payload: ScheduledJobPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

export async function spawnIsolatedJobRunner(
    job: ScheduledJob,
    trigger: "scheduled" | "manual",
    runId?: string,
): Promise<string> {
    const projectRoot = resolveProjectRoot();
    const cliPath = join(projectRoot, "bin", "fyuo.js");
    const encoded = encodeJob({ job, ...(runId ? { runId } : {}) });
    const repository = new SchedulerRepository(projectRoot);

    return await new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn(
            process.execPath,
            [cliPath, "--run-scheduled-job", encoded, "--trigger", trigger],
            {
                cwd: projectRoot,
                stdio: ["ignore", "pipe", "pipe"],
                env: process.env,
                windowsHide: process.platform === "win32",
            },
        );

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            stdout += text;
            repository.appendJobLog(
                job.id,
                `run ${runId ?? "unknown"} stdout:\n${text.trimEnd()}`,
            );
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            stderr += text;
            repository.appendJobLog(
                job.id,
                `run ${runId ?? "unknown"} stderr:\n${text.trimEnd()}`,
            );
        });

        child.on("error", (error) => {
            repository.appendJobLog(
                job.id,
                `run ${runId ?? "unknown"} child process error: ${error.message}`,
            );
            rejectPromise(error);
        });

        child.on("exit", (code) => {
            const output = stdout.trim();
            if (code === 0) {
                resolvePromise(output || "(scheduled job completed with no output)");
                return;
            }
            rejectPromise(
                new Error(
                    stderr.trim() ||
                        output ||
                        `scheduled job process exited with code ${code ?? -1}`,
                ),
            );
        });
    });
}
