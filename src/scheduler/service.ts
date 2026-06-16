import {
    appendFileSync,
    closeSync,
    existsSync,
    watch,
    mkdirSync,
    openSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "fs";
import { dirname, join } from "path";
import process from "process";
import { resolveProjectRoot } from "../config/agent-paths.js";

export type ScheduleType = "once" | "interval";
export type JobStatus = "idle" | "running" | "paused";
export type OverlapPolicy = "skip" | "parallel";

export interface ScheduledJob {
    id: string;
    name: string;
    enabled: boolean;
    scheduleType: ScheduleType;
    task: string;
    createdAt: number;
    updatedAt: number;
    nextRunAt: number | null;
    lastRunAt: number | null;
    status: JobStatus;
    overlapPolicy: OverlapPolicy;
    runAt?: string;
    everyMinutes?: number;
    model?: string;
    allowedTools?: string[];
    context?: string;
    activeRuns: number;
}

interface SchedulerStoreShape {
    jobs: ScheduledJob[];
}

export interface SchedulerCreateInput {
    name: string;
    task: string;
    scheduleType: ScheduleType;
    runAt?: string;
    everyMinutes?: number;
    model?: string;
    allowedTools?: string[];
    context?: string;
    overlapPolicy?: OverlapPolicy;
}

export interface DaemonRunRecord {
    runId: string;
    jobId: string;
    jobName: string;
    status: "running" | "completed" | "failed";
    startedAt: number;
    finishedAt: number | null;
    trigger: "scheduled" | "manual";
    finalContent?: string;
    error?: string;
}

export interface ScheduledJobPayload {
    job: ScheduledJob;
    runId?: string;
}

export interface SchedulerDaemonLockInfo {
    pid?: number;
    startedAt?: number;
    projectRoot?: string;
    codeMtimeMs?: number;
}

export interface SchedulerRuntimeHealth {
    lockExists: boolean;
    daemonRunning: boolean;
    lockStale: boolean;
    codeChangedSinceStart: boolean;
    lockPath: string;
    daemonPid: number | null;
    daemonStartedAt: number | null;
    daemonCodeMtimeMs: number | null;
    currentCodeMtimeMs: number;
    daemonLogPath: string;
    jobsLogDir: string;
    tsxCliPath: string;
    tsxCliExists: boolean;
    entryPath: string;
    entryExists: boolean;
    canSpawnJobRunner: boolean;
}

interface RunStoreShape {
    runs: DaemonRunRecord[];
}

export function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: string }).code === "EPERM"
        ) {
            return true;
        }
        return false;
    }
}

export function parseScheduleString(
    value: unknown,
    options: { trim?: boolean; emptyAsUndefined?: boolean } = {},
): string | undefined {
    if (typeof value !== "string") return undefined;
    const next = options.trim === false ? value : value.trim();
    if (options.emptyAsUndefined !== false && next.length === 0) {
        return undefined;
    }
    return next;
}

export function parseScheduleStringArray(value: unknown): string[] | undefined {
    const raw = parseScheduleString(value);
    if (!raw) return undefined;
    const items = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    return items.length > 0 ? items : undefined;
}

export function formatScheduleDateTime(ts: number | null): string {
    if (!ts) return "-";
    return new Date(ts).toLocaleString("zh-CN");
}

function createJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function parseRunAt(input: string): number {
    const value = Date.parse(input);
    if (Number.isNaN(value)) {
        throw new Error(
            "run_at 无法解析。请使用 ISO 时间，例如 2026-06-15T18:30:00+08:00",
        );
    }
    return value;
}

export function computeNextRunAt(
    job: ScheduledJob,
    now = Date.now(),
): number | null {
    if (!job.enabled) return null;
    if (job.scheduleType === "once") {
        const runAt = parseScheduleString(job.runAt);
        if (!runAt) return null;
        if (job.lastRunAt) {
            return null;
        }
        return parseRunAt(runAt);
    }

    const intervalMinutes = job.everyMinutes;
    if (!intervalMinutes || intervalMinutes <= 0) return null;

    if (!job.lastRunAt) {
        return now + intervalMinutes * 60_000;
    }

    const next = job.lastRunAt + intervalMinutes * 60_000;
    return next > now ? next : now;
}

function validateJob(job: ScheduledJob): void {
    if (!job.name.trim()) throw new Error("任务名称不能为空。");
    if (!job.task.trim()) throw new Error("任务内容不能为空。");
    if (job.scheduleType === "once") {
        if (!parseScheduleString(job.runAt)) {
            throw new Error("一次性任务必须提供 run_at。");
        }
        parseRunAt(job.runAt!);
    }
    if (job.scheduleType === "interval") {
        if (!job.everyMinutes || job.everyMinutes <= 0) {
            throw new Error("循环任务必须提供大于 0 的 every_minutes。");
        }
    }
}

function isCompletedOneTimeJob(job: ScheduledJob): boolean {
    return (
        job.scheduleType === "once" &&
        job.activeRuns <= 0 &&
        job.lastRunAt !== null &&
        job.nextRunAt === null
    );
}

function buildSchedulePaths(projectRoot: string) {
    const baseDir = join(projectRoot, ".fyuobot", "schedules");
    return {
        baseDir,
        jobsPath: join(baseDir, "jobs.json"),
        runsPath: join(baseDir, "runs.json"),
        lockPath: join(baseDir, "daemon.lock"),
        logsDir: join(baseDir, "logs"),
        daemonLogPath: join(baseDir, "logs", "daemon.log"),
        jobsLogDir: join(baseDir, "logs", "jobs"),
    };
}

function getSchedulerCodeFiles(projectRoot: string): string[] {
    return [
        join(projectRoot, "src", "scheduler", "service.ts"),
        join(projectRoot, "src", "daemon", "bootstrap.ts"),
        join(projectRoot, "src", "daemon", "job-runner.ts"),
        join(projectRoot, "src", "daemon", "run-job.ts"),
        join(projectRoot, "src", "daemon", "daemon-control.ts"),
        join(projectRoot, "src", "tui", "index.tsx"),
    ];
}

export function getSchedulerCodeMtimeMs(
    projectRoot = resolveProjectRoot(),
): number {
    let latest = 0;
    for (const file of getSchedulerCodeFiles(projectRoot)) {
        try {
            latest = Math.max(latest, statSync(file).mtimeMs);
        } catch {
            // ignore missing files; runtime health will expose missing entry/tsx separately
        }
    }
    return latest;
}

export function inspectSchedulerRuntime(
    projectRoot = resolveProjectRoot(),
): SchedulerRuntimeHealth {
    const paths = buildSchedulePaths(projectRoot);
    const tsxCliPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const entryPath = join(projectRoot, "src", "tui", "index.tsx");
    const tsxCliExists = existsSync(tsxCliPath);
    const entryExists = existsSync(entryPath);
    const lockExists = existsSync(paths.lockPath);
    let daemonPid: number | null = null;
    let daemonStartedAt: number | null = null;
    let daemonCodeMtimeMs: number | null = null;
    let daemonRunning = false;
    let lockStale = false;
    const currentCodeMtimeMs = getSchedulerCodeMtimeMs(projectRoot);
    let codeChangedSinceStart = false;

    if (lockExists) {
        try {
            const raw = JSON.parse(
                readFileSync(paths.lockPath, "utf-8"),
            ) as SchedulerDaemonLockInfo;
            daemonPid =
                typeof raw.pid === "number" && Number.isFinite(raw.pid)
                    ? raw.pid
                    : null;
            daemonStartedAt =
                typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)
                    ? raw.startedAt
                    : null;
            daemonCodeMtimeMs =
                typeof raw.codeMtimeMs === "number" &&
                Number.isFinite(raw.codeMtimeMs)
                    ? raw.codeMtimeMs
                    : null;
            daemonRunning = daemonPid !== null ? isProcessRunning(daemonPid) : true;
            lockStale = daemonPid !== null ? !daemonRunning : false;
            const comparisonBase = daemonCodeMtimeMs ?? daemonStartedAt;
            codeChangedSinceStart =
                daemonRunning &&
                comparisonBase !== null &&
                currentCodeMtimeMs > comparisonBase + 1;
        } catch {
            daemonRunning = true;
        }
    }

    return {
        lockExists,
        daemonRunning,
        lockStale,
        codeChangedSinceStart,
        lockPath: paths.lockPath,
        daemonPid,
        daemonStartedAt,
        daemonCodeMtimeMs,
        currentCodeMtimeMs,
        daemonLogPath: paths.daemonLogPath,
        jobsLogDir: paths.jobsLogDir,
        tsxCliPath,
        tsxCliExists,
        entryPath,
        entryExists,
        canSpawnJobRunner: tsxCliExists && entryExists,
    };
}

export class SchedulerRepository {
    private readonly projectRoot: string;
    private readonly jobsPath: string;
    private readonly runsPath: string;
    private readonly lockPath: string;
    private readonly logsDir: string;
    private readonly daemonLogPath: string;
    private readonly jobsLogDir: string;

    constructor(projectRoot = resolveProjectRoot()) {
        this.projectRoot = projectRoot;
        const paths = buildSchedulePaths(projectRoot);
        this.jobsPath = paths.jobsPath;
        this.runsPath = paths.runsPath;
        this.lockPath = paths.lockPath;
        this.logsDir = paths.logsDir;
        this.daemonLogPath = paths.daemonLogPath;
        this.jobsLogDir = paths.jobsLogDir;
    }

    getProjectRoot(): string {
        return this.projectRoot;
    }

    getLockPath(): string {
        return this.lockPath;
    }

    getDaemonLogPath(): string {
        return this.daemonLogPath;
    }

    getJobsLogDir(): string {
        return this.jobsLogDir;
    }

    isDaemonRunning(): boolean {
        return inspectSchedulerRuntime(this.projectRoot).daemonRunning;
    }

    readDaemonLockInfo(): SchedulerDaemonLockInfo | null {
        if (!existsSync(this.lockPath)) {
            return null;
        }
        try {
            return JSON.parse(
                readFileSync(this.lockPath, "utf-8"),
            ) as SchedulerDaemonLockInfo;
        } catch {
            return null;
        }
    }

    removeLockFile(): void {
        try {
            unlinkSync(this.lockPath);
        } catch {
            // noop
        }
    }

    ensureDir(): void {
        mkdirSync(dirname(this.jobsPath), { recursive: true });
    }

    private ensureLogDir(): void {
        mkdirSync(this.jobsLogDir, { recursive: true });
    }

    private formatLogLine(scope: string, message: string): string {
        return `[${new Date().toISOString()}] [${scope}] ${message}\n`;
    }

    appendDaemonLog(message: string): void {
        this.ensureLogDir();
        appendFileSync(
            this.daemonLogPath,
            this.formatLogLine("daemon", message),
            "utf-8",
        );
    }

    appendJobLog(jobId: string, message: string): void {
        this.ensureLogDir();
        appendFileSync(
            join(this.jobsLogDir, `${jobId}.log`),
            this.formatLogLine(jobId, message),
            "utf-8",
        );
    }

    loadJobs(): ScheduledJob[] {
        this.ensureDir();
        if (!existsSync(this.jobsPath)) {
            this.saveJobs([]);
            return [];
        }

        try {
            const raw = JSON.parse(
                readFileSync(this.jobsPath, "utf-8"),
            ) as SchedulerStoreShape;
            const jobs = (raw.jobs ?? []).map((item) => {
                const job: ScheduledJob = {
                    ...item,
                    activeRuns: item.activeRuns ?? 0,
                    status: item.enabled
                        ? item.activeRuns > 0
                            ? "running"
                            : "idle"
                        : "paused",
                };
                job.nextRunAt = computeNextRunAt(job);
                return job;
            }).filter((job) => !isCompletedOneTimeJob(job));
            if (jobs.length !== (raw.jobs ?? []).length) {
                this.saveJobs(jobs);
            }
            return jobs;
        } catch (error) {
            console.warn(
                "[schedule] 加载任务失败，已重置任务文件:",
                error instanceof Error ? error.message : String(error),
            );
            this.saveJobs([]);
            return [];
        }
    }

    saveJobs(jobs: ScheduledJob[]): void {
        this.ensureDir();
        writeFileSync(
            this.jobsPath,
            `${JSON.stringify({ jobs }, null, 2)}\n`,
            "utf-8",
        );
    }

    appendRun(run: DaemonRunRecord): void {
        const current = this.loadRuns();
        current.unshift(run);
        writeFileSync(
            this.runsPath,
            `${JSON.stringify({ runs: current.slice(0, 200) }, null, 2)}\n`,
            "utf-8",
        );
    }

    updateRun(runId: string, patch: Partial<DaemonRunRecord>): void {
        const current = this.loadRuns();
        const next = current.map((run) =>
            run.runId === runId ? { ...run, ...patch } : run,
        );
        writeFileSync(
            this.runsPath,
            `${JSON.stringify({ runs: next }, null, 2)}\n`,
            "utf-8",
        );
    }

    loadRuns(): DaemonRunRecord[] {
        this.ensureDir();
        if (!existsSync(this.runsPath)) {
            writeFileSync(
                this.runsPath,
                `${JSON.stringify({ runs: [] }, null, 2)}\n`,
                "utf-8",
            );
            return [];
        }

        try {
            const raw = JSON.parse(
                readFileSync(this.runsPath, "utf-8"),
            ) as RunStoreShape;
            return raw.runs ?? [];
        } catch {
            return [];
        }
    }
}

export class SchedulerJobManager {
    private readonly repository: SchedulerRepository;
    private jobs = new Map<string, ScheduledJob>();

    constructor(repository = new SchedulerRepository()) {
        this.repository = repository;
        this.reload();
    }

    reload(): ScheduledJob[] {
        this.jobs.clear();
        for (const job of this.repository.loadJobs()) {
            this.jobs.set(job.id, job);
        }
        return this.list();
    }

    list(): ScheduledJob[] {
        return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    }

    recentRuns(): DaemonRunRecord[] {
        return this.repository.loadRuns();
    }

    create(input: SchedulerCreateInput): ScheduledJob {
        const now = Date.now();
        const job: ScheduledJob = {
            id: createJobId(),
            name: input.name,
            enabled: true,
            scheduleType: input.scheduleType,
            task: input.task,
            createdAt: now,
            updatedAt: now,
            nextRunAt: null,
            lastRunAt: null,
            status: "idle",
            overlapPolicy: input.overlapPolicy ?? "skip",
            ...(input.runAt ? { runAt: input.runAt } : {}),
            ...(input.everyMinutes ? { everyMinutes: input.everyMinutes } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
            ...(input.context ? { context: input.context } : {}),
            activeRuns: 0,
        };
        validateJob(job);
        job.nextRunAt = computeNextRunAt(job, now);
        this.jobs.set(job.id, job);
        this.persist();
        return job;
    }

    pause(identifier: string): ScheduledJob {
        const job = this.requireJob(identifier);
        job.enabled = false;
        job.status = "paused";
        job.nextRunAt = null;
        job.updatedAt = Date.now();
        this.persist();
        return job;
    }

    resume(identifier: string): ScheduledJob {
        const job = this.requireJob(identifier);
        job.enabled = true;
        job.status = job.activeRuns > 0 ? "running" : "idle";
        job.updatedAt = Date.now();
        job.nextRunAt = computeNextRunAt(job);
        this.persist();
        return job;
    }

    delete(identifier: string): ScheduledJob {
        const job = this.requireJob(identifier);
        this.jobs.delete(job.id);
        this.persist();
        return job;
    }

    markRunStart(jobId: string): ScheduledJob {
        const job = this.requireJob(jobId);
        const startedAt = Date.now();
        job.activeRuns += 1;
        job.status = "running";
        job.updatedAt = startedAt;
        job.lastRunAt = startedAt;
        job.nextRunAt =
            job.scheduleType === "once"
                ? null
                : computeNextRunAt({ ...job, lastRunAt: startedAt }, startedAt);
        this.persist();
        return job;
    }

    markRunEnd(jobId: string): ScheduledJob {
        const job = this.requireJob(jobId);
        job.activeRuns = Math.max(0, job.activeRuns - 1);
        if (job.scheduleType === "once" && job.nextRunAt === null) {
            job.enabled = false;
        }
        if (this.isCompletedOneTimeJob(job)) {
            this.jobs.delete(job.id);
            this.persist();
            return job;
        }
        job.status = job.enabled ? "idle" : "paused";
        job.updatedAt = Date.now();
        this.persist();
        return job;
    }

    requireJob(identifier: string): ScheduledJob {
        const normalized = identifier.trim().toLowerCase();
        const direct = this.jobs.get(identifier);
        if (direct) return direct;
        const byName = [...this.jobs.values()].find(
            (job) => job.name.trim().toLowerCase() === normalized,
        );
        if (!byName) {
            throw new Error(`未找到任务: ${identifier}`);
        }
        return byName;
    }

    persist(): void {
        this.repository.saveJobs(this.list());
    }

    private isCompletedOneTimeJob(job: ScheduledJob): boolean {
        return isCompletedOneTimeJob(job);
    }
}

export class SchedulerDaemonLock {
    private readonly repository: SchedulerRepository;
    private readonly lockPath: string;
    private fd: number | null = null;

    constructor(repository: SchedulerRepository) {
        this.repository = repository;
        this.lockPath = repository.getLockPath();
    }

    acquire(): void {
        mkdirSync(dirname(this.lockPath), { recursive: true });
        if (existsSync(this.lockPath)) {
            const info = this.repository.readDaemonLockInfo();
            if (info?.pid && !isProcessRunning(info.pid)) {
                this.repository.removeLockFile();
            }
        }
        try {
            this.fd = openSync(this.lockPath, "wx");
            writeSync(
                this.fd,
                `${JSON.stringify(
                    {
                        pid: process.pid,
                        startedAt: Date.now(),
                        projectRoot: this.repository.getProjectRoot(),
                        codeMtimeMs: getSchedulerCodeMtimeMs(
                            this.repository.getProjectRoot(),
                        ),
                    } satisfies SchedulerDaemonLockInfo,
                    null,
                    2,
                )}\n`,
            );
        } catch {
            throw new Error(
                `定时任务 daemon 已在运行，锁文件存在: ${this.lockPath}`,
            );
        }
    }

    release(): void {
        if (this.fd !== null) {
            try {
                closeSync(this.fd);
            } catch {
                // noop
            }
            try {
                unlinkSync(this.lockPath);
            } catch {
                // noop
            }
            this.fd = null;
        }
    }
}

export class SchedulerDaemonService {
    private readonly repository: SchedulerRepository;
    private readonly manager: SchedulerJobManager;
    private readonly executeJobFn: (
        job: ScheduledJob,
        trigger: "scheduled" | "manual",
        runId?: string,
    ) => Promise<string>;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
    private jobsWatcher: ReturnType<typeof watch> | null = null;
    private jobsRescheduleTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private readonly idleShutdownMs: number;

    constructor(options: {
        repository?: SchedulerRepository;
        executeJob: (
            job: ScheduledJob,
            trigger: "scheduled" | "manual",
            runId?: string,
        ) => Promise<string>;
        idleShutdownMs?: number;
    }) {
        this.repository = options.repository ?? new SchedulerRepository();
        this.manager = new SchedulerJobManager(this.repository);
        this.executeJobFn = options.executeJob;
        this.idleShutdownMs = options.idleShutdownMs ?? 5 * 60_000;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.manager.reload();
        this.repository.appendDaemonLog("scheduler daemon started");
        this.startJobsWatcher();
        this.scheduleNext();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.idleShutdownTimer) {
            clearTimeout(this.idleShutdownTimer);
            this.idleShutdownTimer = null;
        }
        if (this.jobsRescheduleTimer) {
            clearTimeout(this.jobsRescheduleTimer);
            this.jobsRescheduleTimer = null;
        }
        if (this.jobsWatcher) {
            this.jobsWatcher.close();
            this.jobsWatcher = null;
        }
        this.repository.appendDaemonLog("scheduler daemon stopped");
    }

    private isDaemonTrackedJob(job: ScheduledJob): boolean {
        return job.enabled && (job.nextRunAt !== null || job.activeRuns > 0);
    }

    private getDaemonJobSnapshot(): {
        trackedJobs: ScheduledJob[];
        pendingJobs: ScheduledJob[];
        runningJobs: ScheduledJob[];
    } {
        const trackedJobs = this.manager
            .list()
            .filter((job) => this.isDaemonTrackedJob(job));
        return {
            trackedJobs,
            pendingJobs: trackedJobs.filter((job) => job.nextRunAt !== null),
            runningJobs: trackedJobs.filter((job) => job.activeRuns > 0),
        };
    }

    private scheduleNext(): void {
        if (!this.running) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.manager.reload();
        const { trackedJobs, pendingJobs, runningJobs } =
            this.getDaemonJobSnapshot();
        const nextDue = pendingJobs
            .map((job) => job.nextRunAt as number)
            .sort((a, b) => a - b)[0];

        if (!nextDue) {
            if (runningJobs.length > 0) {
                this.clearIdleShutdownTimer();
                this.repository.appendDaemonLog(
                    `no pending jobs, but ${runningJobs.length} running job(s) still active; idle shutdown suspended; next scan in 30000ms`,
                );
            } else {
                this.armIdleShutdownIfNeeded(trackedJobs.length);
                this.repository.appendDaemonLog(
                    "no pending jobs or running jobs, next scan in 30000ms",
                );
            }
            this.timer = setTimeout(() => this.scheduleNext(), 30_000);
            return;
        }

        this.clearIdleShutdownTimer();

        const delay = Math.max(0, nextDue - Date.now());
        this.repository.appendDaemonLog(
            `next due job scheduled in ${delay}ms`,
        );
        this.timer = setTimeout(() => {
            void this.flushDueJobs();
        }, delay);
    }

    private async flushDueJobs(): Promise<void> {
        if (!this.running) return;
        this.manager.reload();
        const now = Date.now();
        const dueJobs = this.manager.list().filter(
            (job) =>
                job.enabled &&
                job.nextRunAt !== null &&
                job.nextRunAt <= now,
        );

        for (const job of dueJobs) {
            if (job.activeRuns > 0 && job.overlapPolicy === "skip") {
                this.repository.appendDaemonLog(
                    `skip overlapping run for job ${job.name} (${job.id})`,
                );
                this.repository.appendJobLog(
                    job.id,
                    `skip overlapping scheduled run because overlap_policy=skip and activeRuns=${job.activeRuns}`,
                );
                continue;
            }
            void this.runJob(job.id, "scheduled");
        }

        this.scheduleNext();
    }

    async runJob(
        jobId: string,
        trigger: "scheduled" | "manual",
    ): Promise<void> {
        const job = this.manager.markRunStart(jobId);
        const runId = createRunId();
        this.repository.appendDaemonLog(
            `run ${runId} started for job ${job.name} (${job.id}), trigger=${trigger}`,
        );
        this.repository.appendJobLog(
            job.id,
            `run ${runId} started, trigger=${trigger}, task=${job.task}`,
        );
        this.repository.appendRun({
            runId,
            jobId: job.id,
            jobName: job.name,
            status: "running",
            startedAt: Date.now(),
            finishedAt: null,
            trigger,
        });

        try {
            const result = await this.executeJobFn(job, trigger, runId);
            this.repository.updateRun(runId, {
                status: "completed",
                finishedAt: Date.now(),
                finalContent: result,
            });
            this.repository.appendDaemonLog(
                `run ${runId} completed for job ${job.name} (${job.id})`,
            );
            this.repository.appendJobLog(
                job.id,
                `run ${runId} completed\n${result}`,
            );
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);
            this.repository.updateRun(runId, {
                status: "failed",
                finishedAt: Date.now(),
                error: reason,
            });
            this.repository.appendDaemonLog(
                `run ${runId} failed for job ${job.name} (${job.id}): ${reason}`,
            );
            this.repository.appendJobLog(
                job.id,
                `run ${runId} failed: ${reason}`,
            );
        } finally {
            this.manager.markRunEnd(job.id);
            this.repository.appendJobLog(
                job.id,
                `run ${runId} finalized, job status reset`,
            );
            this.scheduleNext();
        }
    }

    private armIdleShutdownIfNeeded(activeJobCount: number): void {
        if (activeJobCount > 0 || !this.running || this.idleShutdownTimer) {
            return;
        }
        this.repository.appendDaemonLog(
            `no pending or running jobs, idle shutdown armed for ${this.idleShutdownMs}ms`,
        );
        this.idleShutdownTimer = setTimeout(() => {
            void this.shutdownIfStillIdle();
        }, this.idleShutdownMs);
    }

    private clearIdleShutdownTimer(): void {
        if (this.idleShutdownTimer) {
            clearTimeout(this.idleShutdownTimer);
            this.idleShutdownTimer = null;
        }
    }

    private startJobsWatcher(): void {
        const schedulesDir = join(
            this.repository.getProjectRoot(),
            ".fyuobot",
            "schedules",
        );
        const jobsPath = join(schedulesDir, "jobs.json");
        try {
            mkdirSync(schedulesDir, { recursive: true });
            this.jobsWatcher = watch(schedulesDir, (_eventType, filename) => {
                const name = filename?.toString() ?? "";
                if (name && name !== "jobs.json") {
                    return;
                }
                this.queueJobsReschedule("jobs file changed");
            });
            this.jobsWatcher.on("error", (error) => {
                this.repository.appendDaemonLog(
                    `jobs watcher error: ${error.message}`,
                );
            });
            this.repository.appendDaemonLog(
                `watching scheduler jobs file: ${jobsPath}`,
            );
        } catch (error) {
            this.repository.appendDaemonLog(
                `jobs watcher unavailable: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private queueJobsReschedule(reason: string): void {
        if (!this.running) {
            return;
        }
        if (this.jobsRescheduleTimer) {
            clearTimeout(this.jobsRescheduleTimer);
        }
        this.jobsRescheduleTimer = setTimeout(() => {
            this.jobsRescheduleTimer = null;
            this.repository.appendDaemonLog(
                `rescheduling due to dynamic scheduler change: ${reason}`,
            );
            this.scheduleNext();
        }, 150);
    }

    private async shutdownIfStillIdle(): Promise<void> {
        this.idleShutdownTimer = null;
        if (!this.running) {
            return;
        }
        this.manager.reload();
        const { trackedJobs, pendingJobs, runningJobs } =
            this.getDaemonJobSnapshot();
        if (trackedJobs.length > 0) {
            this.repository.appendDaemonLog(
                `idle shutdown canceled because ${pendingJobs.length} pending and ${runningJobs.length} running job(s) still exist`,
            );
            this.scheduleNext();
            return;
        }
        this.repository.appendDaemonLog(
            "idle shutdown triggered because there are no pending or running jobs",
        );
        process.kill(process.pid, "SIGTERM");
    }
}
