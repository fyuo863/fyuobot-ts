import type { Agent } from "../agent/agent.js";
import {
    ensureSchedulerDaemon,
    restartSchedulerDaemon,
    startSchedulerDaemon,
    stopSchedulerDaemon,
} from "../daemon/daemon-control.js";
import {
    SchedulerJobManager,
    SchedulerRepository,
    formatScheduleDateTime,
    inspectSchedulerRuntime,
    parseScheduleString,
    parseScheduleStringArray,
    type OverlapPolicy,
    type ScheduleType,
    type ScheduledJob,
} from "../scheduler/service.js";
import { BaseTool, type ToolParam } from "./basetool.js";

type ScheduleAction =
    | "create"
    | "list"
    | "status"
    | "daemon_start"
    | "daemon_stop"
    | "daemon_restart"
    | "pause"
    | "resume"
    | "delete"
    | "runs";

export class ScheduleTaskTool extends BaseTool {
    name = "schedule_task";

    description = [
        "创建和管理 Agent 定时任务。",
        "此工具只负责管理任务定义；真正的定时执行由独立 daemon 进程负责。",
        "适合通过对话直接创建、查看、暂停、恢复、删除任务，以及查看最近执行记录。",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "action",
            type: "string",
            description:
                "操作类型：create、list、status、daemon_start、daemon_stop、daemon_restart、pause、resume、delete、runs。",
            required: true,
            enum: ["create", "list", "status", "daemon_start", "daemon_stop", "daemon_restart", "pause", "resume", "delete", "runs"],
        },
        {
            name: "name",
            type: "string",
            description:
                "任务名称。create 时必填；pause/resume/delete 时可用名称定位。",
            required: false,
        },
        {
            name: "job_id",
            type: "string",
            description: "任务 ID。pause/resume/delete 时可用 ID 精确定位。",
            required: false,
        },
        {
            name: "task",
            type: "string",
            description: "要定时执行的任务内容。create 时必填。",
            required: false,
        },
        {
            name: "schedule_type",
            type: "string",
            description: "调度类型：once 或 interval。create 时必填。",
            required: false,
            enum: ["once", "interval"],
        },
        {
            name: "run_at",
            type: "string",
            description:
                "一次性任务执行时间，ISO 格式，例如 2026-06-15T18:30:00+08:00。",
            required: false,
        },
        {
            name: "every_minutes",
            type: "number",
            description: "循环任务间隔分钟数。schedule_type=interval 时必填。",
            required: false,
        },
        {
            name: "model",
            type: "string",
            description: "可选：后台独立任务执行时使用的模型。",
            required: false,
        },
        {
            name: "allowed_tools",
            type: "string",
            description: "可选：允许的工具名，逗号分隔。",
            required: false,
        },
        {
            name: "context",
            type: "string",
            description: "可选：附加给定时任务的额外上下文。",
            required: false,
        },
        {
            name: "overlap_policy",
            type: "string",
            description: "任务重叠策略，skip 或 parallel，默认 skip。",
            required: false,
            enum: ["skip", "parallel"],
        },
    ];

    private manager: SchedulerJobManager | null = null;

    onInit(_agent: Agent): void {
        this.manager = new SchedulerJobManager();
    }

    async execute(args: Record<string, unknown>): Promise<string> {
        const manager = this.manager ?? new SchedulerJobManager();
        this.manager = manager;
        manager.reload();
        const action = parseScheduleString(args["action"]) as
            | ScheduleAction
            | undefined;
        if (!action) {
            return "❌ 缺少 action。";
        }

        try {
            switch (action) {
                case "list":
                    return this.renderList(manager.list());
                case "status":
                    return this.renderStatus(manager);
                case "daemon_start":
                    return this.renderDaemonControlResult(startSchedulerDaemon());
                case "daemon_stop":
                    return this.renderDaemonControlResult(stopSchedulerDaemon());
                case "daemon_restart":
                    return this.renderDaemonControlResult(restartSchedulerDaemon());
                case "create":
                    return this.handleCreate(manager, args);
                case "pause":
                    return this.handleStateChange("pause", manager, args);
                case "resume":
                    return this.handleStateChange("resume", manager, args);
                case "delete":
                    return this.handleDelete(manager, args);
                case "runs":
                    return this.renderRuns(manager.recentRuns());
                default:
                    return `❌ 不支持的 action: ${action}`;
            }
        } catch (error) {
            return `❌ ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private resolveIdentifier(args: Record<string, unknown>): string {
        const identifier = parseScheduleString(args["job_id"]) ?? parseScheduleString(args["name"]);
        if (!identifier) {
            throw new Error("请提供 job_id 或 name。");
        }
        return identifier;
    }

    private handleCreate(
        manager: SchedulerJobManager,
        args: Record<string, unknown>,
    ): string {
        const name = parseScheduleString(args["name"]);
        const task = parseScheduleString(args["task"]);
        const scheduleType = parseScheduleString(args["schedule_type"]) as
            | ScheduleType
            | undefined;

        if (!name) throw new Error("create 需要 name。");
        if (!task) throw new Error("create 需要 task。");
        if (!scheduleType) throw new Error("create 需要 schedule_type。");

        const everyMinutesRaw = args["every_minutes"];
        const everyMinutes =
            typeof everyMinutesRaw === "number"
                ? everyMinutesRaw
                : typeof everyMinutesRaw === "string" && everyMinutesRaw.trim()
                  ? Number(everyMinutesRaw)
                  : undefined;

        const runAt = parseScheduleString(args["run_at"]);
        const model = parseScheduleString(args["model"]);
        const allowedTools = parseScheduleStringArray(args["allowed_tools"]);
        const context = parseScheduleString(args["context"], {
            emptyAsUndefined: true,
        });
        const job = manager.create({
            name,
            task,
            scheduleType,
            ...(runAt ? { runAt } : {}),
            ...(everyMinutes !== undefined ? { everyMinutes } : {}),
            ...(model ? { model } : {}),
            ...(allowedTools ? { allowedTools } : {}),
            ...(context ? { context } : {}),
            overlapPolicy:
                (parseScheduleString(args["overlap_policy"]) as
                    | OverlapPolicy
                    | undefined) ?? "skip",
        });
        const daemonResult = ensureSchedulerDaemon();

        return [
            "✅ 已创建定时任务",
            `ID: ${job.id}`,
            `名称: ${job.name}`,
            `类型: ${job.scheduleType}`,
            `下次执行: ${formatScheduleDateTime(job.nextRunAt)}`,
            `任务: ${job.task}`,
            daemonResult.ok
                ? `daemon: ${daemonResult.started ? "已自动启动" : "已在线"}`
                : `daemon 自动启动失败: ${daemonResult.message}`,
            ...this.renderRuntimeHints(),
        ].join("\n");
    }

    private handleStateChange(
        action: "pause" | "resume",
        manager: SchedulerJobManager,
        args: Record<string, unknown>,
    ): string {
        const identifier = this.resolveIdentifier(args);
        const job =
            action === "pause"
                ? manager.pause(identifier)
                : manager.resume(identifier);

        return [
            `✅ 已${action === "pause" ? "暂停" : "恢复"}任务`,
            `ID: ${job.id}`,
            `名称: ${job.name}`,
            `状态: ${job.status}`,
            `下次执行: ${formatScheduleDateTime(job.nextRunAt)}`,
        ].join("\n");
    }

    private handleDelete(
        manager: SchedulerJobManager,
        args: Record<string, unknown>,
    ): string {
        const identifier = this.resolveIdentifier(args);
        const job = manager.delete(identifier);
        return `✅ 已删除任务: ${job.name} (${job.id})`;
    }

    private renderStatus(manager: SchedulerJobManager): string {
        const repository = new SchedulerRepository();
        const runtime = inspectSchedulerRuntime();
        const jobs = manager.list();
        const runs = manager.recentRuns();
        const latestRun = runs[0];
        const enabledJobs = jobs.filter((job) => job.enabled);
        const pendingJobs = enabledJobs.filter((job) => job.nextRunAt !== null);
        const runningJobs = enabledJobs.filter((job) => job.activeRuns > 0);

        return [
            "定时任务 daemon 状态",
            `运行中: ${runtime.daemonRunning ? "是" : "否"}`,
            `锁文件存在: ${runtime.lockExists ? "是" : "否"}`,
            `锁文件失效: ${runtime.lockStale ? "是" : "否"}`,
            `daemon PID: ${runtime.daemonPid ?? "-"}`,
            `daemon 启动时间: ${formatScheduleDateTime(runtime.daemonStartedAt)}`,
            `锁文件: ${runtime.lockPath}`,
            `daemon 日志: ${runtime.daemonLogPath}`,
            `任务日志目录: ${runtime.jobsLogDir}`,
            `tsx CLI: ${runtime.tsxCliExists ? "可用" : "缺失"} (${runtime.tsxCliPath})`,
            `任务执行入口: ${runtime.entryExists ? "可用" : "缺失"} (${runtime.entryPath})`,
            `可启动子任务执行器: ${runtime.canSpawnJobRunner ? "是" : "否"}`,
            `任务总数: ${jobs.length}`,
            `启用任务: ${enabledJobs.length}`,
            `待调度任务: ${pendingJobs.length}`,
            `运行中任务: ${runningJobs.length}`,
            latestRun
                ? `最近执行: ${latestRun.jobName} / ${latestRun.status} / ${formatScheduleDateTime(latestRun.finishedAt ?? latestRun.startedAt)}`
                : "最近执行: -",
        ].join("\n");
    }

    private renderRuntimeHints(): string[] {
        const runtime = inspectSchedulerRuntime();
        const hints = [
            runtime.daemonRunning
                ? "daemon 状态: 已运行"
                : "daemon 状态: 未运行，需要启动 `fyuo --daemon` 才会真正自动执行。",
        ];

        if (!runtime.canSpawnJobRunner) {
            hints.push("⚠ 运行链路自检失败：定时任务执行器缺少必要入口。");
            if (!runtime.tsxCliExists) {
                hints.push(`- 缺少 tsx CLI: ${runtime.tsxCliPath}`);
            }
            if (!runtime.entryExists) {
                hints.push(`- 缺少执行入口: ${runtime.entryPath}`);
            }
        } else {
            hints.push("运行链路自检: 通过");
        }

        return hints;
    }

    private renderDaemonControlResult(result: {
        ok: boolean;
        message: string;
    }): string {
        const runtime = inspectSchedulerRuntime();
        return [
            result.ok ? "✅ daemon 操作已执行" : "❌ daemon 操作失败",
            result.message,
            `当前运行中: ${runtime.daemonRunning ? "是" : "否"}`,
            `当前 PID: ${runtime.daemonPid ?? "-"}`,
            `锁文件: ${runtime.lockPath}`,
        ].join("\n");
    }

    private renderList(jobs: ScheduledJob[]): string {
        if (jobs.length === 0) {
            return [
                "当前没有定时任务。",
                "如需自动执行，请先创建任务，再单独启动 daemon：fyuo --daemon",
            ].join("\n");
        }

        return jobs
            .map((job, index) =>
                [
                    `${index + 1}. ${job.name}`,
                    `ID: ${job.id}`,
                    `状态: ${job.status}${job.enabled ? "" : " (disabled)"}`,
                    `类型: ${job.scheduleType}`,
                    `下次执行: ${formatScheduleDateTime(job.nextRunAt)}`,
                    `上次执行: ${formatScheduleDateTime(job.lastRunAt)}`,
                    `任务: ${job.task}`,
                ].join("\n"),
            )
            .join("\n\n");
    }

    private renderRuns(
        runs: ReturnType<SchedulerJobManager["recentRuns"]>,
    ): string {
        if (runs.length === 0) {
            return [
                "当前没有执行记录。",
                "如果你已经创建任务但没有记录，请确认 daemon 正在运行：fyuo --daemon",
            ].join("\n");
        }

        return runs
            .slice(0, 10)
            .map((run, index) =>
                [
                    `${index + 1}. ${run.jobName}`,
                    `Run ID: ${run.runId}`,
                    `状态: ${run.status}`,
                    `触发方式: ${run.trigger}`,
                    `开始: ${formatScheduleDateTime(run.startedAt)}`,
                    `结束: ${formatScheduleDateTime(run.finishedAt)}`,
                    run.error ? `错误: ${run.error}` : "",
                ]
                    .filter(Boolean)
                    .join("\n"),
            )
            .join("\n\n");
    }
}
