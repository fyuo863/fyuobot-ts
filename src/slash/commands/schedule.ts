import {
    ensureSchedulerDaemon,
} from "../../daemon/daemon-control.js";
import {
    SchedulerJobManager,
    formatScheduleDateTime,
    inspectSchedulerRuntime,
    type OverlapPolicy,
    type ScheduleType,
} from "../../scheduler/service.js";
import type { CommandContext, SlashCommand } from "../types.js";

function parseKeyValueArgs(input: string): Record<string, string> {
    const result: Record<string, string> = {};
    const regex = /(\w+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
    for (const match of input.matchAll(regex)) {
        const key = match[1]!;
        const raw = match[3] ?? match[4] ?? match[2] ?? "";
        result[key] = raw.replace(/^['"]|['"]$/g, "");
    }
    return result;
}

function renderHelp(): string {
    return [
        "用法：",
        "/schedule list",
        "/schedule runs",
        '/schedule create name=myjob type=interval every=30 task="每 30 分钟检查日志异常"',
        '/schedule create name=oncejob type=once at="2026-06-15T18:30:00+08:00" task="提醒我发布版本"',
        "/schedule pause <job_id|name>",
        "/schedule resume <job_id|name>",
        "/schedule delete <job_id|name>",
        "",
        "create 参数：",
        "name=任务名",
        "type=once|interval",
        "at=ISO时间（once 必填）",
        "every=分钟数（interval 必填）",
        "task=任务内容",
        "model=可选模型",
        "tools=逗号分隔允许工具",
        "context=附加上下文",
        "overlap=skip|parallel",
        "",
        "说明：创建任务后会自动确保 daemon 已启动。",
        "关闭当前会话可用：/exit",
    ].join("\n");
}

function renderList(manager: SchedulerJobManager): string {
    const jobs = manager.list();
    if (jobs.length === 0) {
        return "当前没有定时任务。";
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

function renderRuns(manager: SchedulerJobManager): string {
    const runs = manager.recentRuns();
    if (runs.length === 0) {
        return "当前没有执行记录。";
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

function parseIdentifier(arg: string): string {
    const trimmed = arg.trim();
    if (!trimmed) {
        throw new Error("缺少任务标识，请提供 job_id 或 name。");
    }
    return trimmed;
}

export const scheduleCommand: SlashCommand = {
    name: "schedule",
    aliases: ["cron", "sched"],
    description: "管理定时任务和查看最近执行记录",

    async execute(ctx: CommandContext) {
        const input = ctx.args.trim();
        if (!input) {
            return { type: "output", text: renderHelp() };
        }

        const [action, ...rest] = input.split(/\s+/);
        const tail = rest.join(" ").trim();
        const manager = new SchedulerJobManager();

        try {
            switch (action) {
                case "list":
                    return { type: "output", text: renderList(manager) };
                case "runs":
                    return { type: "output", text: renderRuns(manager) };
                case "pause": {
                    const job = manager.pause(parseIdentifier(tail));
                    return {
                        type: "output",
                        text: `已暂停任务 ${job.name} (${job.id})`,
                    };
                }
                case "resume": {
                    const job = manager.resume(parseIdentifier(tail));
                    return {
                        type: "output",
                        text: `已恢复任务 ${job.name} (${job.id})`,
                    };
                }
                case "delete": {
                    const job = manager.delete(parseIdentifier(tail));
                    return {
                        type: "output",
                        text: `已删除任务 ${job.name} (${job.id})`,
                    };
                }
                case "create": {
                    const kv = parseKeyValueArgs(tail);
                    const scheduleType = kv.type as ScheduleType | undefined;
                    if (!kv.name || !scheduleType || !kv.task) {
                        throw new Error("create 至少需要 name=、type=、task=。");
                    }
                    const everyMinutes = kv.every ? Number(kv.every) : undefined;
                    const allowedTools = kv.tools
                        ? kv.tools.split(",").map((item) => item.trim()).filter(Boolean)
                        : undefined;
                    const job = manager.create({
                        name: kv.name,
                        task: kv.task,
                        scheduleType,
                        ...(kv.at ? { runAt: kv.at } : {}),
                        ...(everyMinutes !== undefined ? { everyMinutes } : {}),
                        ...(kv.model ? { model: kv.model } : {}),
                        ...(allowedTools ? { allowedTools } : {}),
                        ...(kv.context ? { context: kv.context } : {}),
                        overlapPolicy: (kv.overlap as OverlapPolicy | undefined) ?? "skip",
                    });
                    const daemonResult = ensureSchedulerDaemon();
                    const runtime = inspectSchedulerRuntime();
                    return {
                        type: "output",
                        text: [
                            `已创建任务 ${job.name} (${job.id})`,
                            `下次执行: ${formatScheduleDateTime(job.nextRunAt)}`,
                            daemonResult.ok
                                ? daemonResult.started
                                    ? "daemon 状态: 已自动启动"
                                    : "daemon 状态: 已运行"
                                : `daemon 自动启动失败: ${daemonResult.message}`,
                            runtime.canSpawnJobRunner
                                ? "运行链路自检: 通过"
                                : `运行链路自检失败：tsx=${runtime.tsxCliExists ? "ok" : "missing"}，entry=${runtime.entryExists ? "ok" : "missing"}`,
                        ].join("\n"),
                    };
                }
                case "help":
                    return { type: "output", text: renderHelp() };
                default:
                    return { type: "output", text: renderHelp() };
            }
        } catch (error) {
            return {
                type: "error",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
