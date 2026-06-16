import { buildAgentIdentity, buildOrderedPromptMessages } from "../agent/prompts.js";
import { AgentRuntime } from "../agent/runtime.js";
import { getAgentPathCandidates, resolveExistingAgentPath } from "../config/agent-paths.js";
import {
    MCPManager,
    normalizeMCPConfig,
    type MCPServerConfig,
} from "../mcp/mcp.js";
import {
    SchedulerRepository,
    type ScheduledJob,
    type ScheduledJobPayload,
} from "../scheduler/service.js";
import { loadToolRegistry } from "../tools/tool-loader.js";
import { readFileSync } from "fs";
import type { BaseTool } from "../tools/basetool.js";

const JOB_RUNNER_DENYLIST = new Set(["api-server"]);

function resolveMCPPath(): string {
    return (
        resolveExistingAgentPath("mcp.json") ??
        getAgentPathCandidates("mcp.json")[0]!
    );
}

function loadMCPServers(): MCPServerConfig[] {
    const configPath = resolveMCPPath();
    try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as unknown;
        return normalizeMCPConfig(config);
    } catch {
        return [];
    }
}

export function decodeScheduledJob(encoded: string): ScheduledJobPayload {
    const raw = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed = JSON.parse(raw) as ScheduledJob | ScheduledJobPayload;
    if ("job" in parsed) {
        return parsed;
    }
    return { job: parsed };
}

export async function runSingleScheduledJob(
    job: ScheduledJob,
    trigger: "scheduled" | "manual",
    runId?: string,
): Promise<string> {
    const repository = new SchedulerRepository();
    repository.appendJobLog(
        job.id,
        `run ${runId ?? "unknown"} child execution bootstrap, trigger=${trigger}`,
    );
    const mcpManager = new MCPManager();
    let mcpTools: BaseTool[] = [];
    const mcpServers = loadMCPServers();
    if (mcpServers.length > 0) {
        repository.appendJobLog(
            job.id,
            `run ${runId ?? "unknown"} connecting MCP servers: ${mcpServers.length}`,
        );
        await mcpManager.connect(mcpServers);
        mcpTools = await mcpManager.discoverAllTools();
    }

    const loaded = await loadToolRegistry({
        installExternalDependencies: true,
        mcpTools,
    });
    const allowlist = (job.allowedTools ?? loaded.registry.names()).filter(
        (name) => !JOB_RUNNER_DENYLIST.has(name),
    );
    const registry = loaded.registry.createFiltered(allowlist);
    const runtime = AgentRuntime.createDefault(registry);
    const agent = runtime.getDefault();

    await registry.initAll(agent);
    runtime.start();

    try {
        const context = buildOrderedPromptMessages({
            identity: buildAgentIdentity(
                `Scheduled Job ${job.name} - 一个独立的后台定时任务 Agent。`,
            ),
            includeUserPreferences: false,
            includeSystemSettings: false,
            extraSystemMessages: [
                [
                    "[定时任务执行上下文]",
                    `任务名: ${job.name}`,
                    `触发方式: ${trigger === "manual" ? "手动" : "定时"}`,
                    "你运行在独立子进程中，不能依赖任何前台会话状态。",
                    job.context?.trim() ? `[附加上下文]\n${job.context.trim()}` : "",
                ]
                    .filter(Boolean)
                    .join("\n"),
            ],
            userQuery: job.task,
        });

        const result = await agent.runTask(job.task, {
            context,
            ...(job.model ? { model: job.model } : {}),
        });
        repository.appendJobLog(
            job.id,
            `run ${runId ?? "unknown"} agent task completed successfully`,
        );
        return result;
    } catch (error) {
        repository.appendJobLog(
            job.id,
            `run ${runId ?? "unknown"} agent task failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        throw error;
    } finally {
        await runtime.stop().catch(() => {});
        await registry.destroyAll().catch(() => {});
        await mcpManager.disconnect().catch(() => {});
        repository.appendJobLog(
            job.id,
            `run ${runId ?? "unknown"} child execution teardown finished`,
        );
    }
}
