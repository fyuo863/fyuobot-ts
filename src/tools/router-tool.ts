import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";
import { Router } from "../router/router.js";

/**
 * 共享的 Router 单例。
 * 所有路由工具共用同一个 Router 实例，保证 Agent 注册和任务数据一致。
 */
export const router = new Router();

// ── 工具定义 ────────────────────────────────────────────────

/**
 * 注册一个 Agent 到路由系统。
 * 注册后该 Agent 才能接收任务（通过 publish_task 发布）。
 */
export class RegisterAgentTool extends BaseTool {
    name = "register_agent";
    description =
        "注册一个 Agent 到路由系统。调用后该 Agent 名称被记录，后续可通过 publish_task 向其发布任务。";

    parameters: ToolParam[] = [
        {
            name: "name",
            type: "string",
            description: "要注册的 Agent 名称，例如 'coder'、'reviewer'、'tester'",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const name = args["name"] as string;
        router.register(name);
        return `✅ Agent "${name}" 已注册。当前已注册 Agent: [${router.registeredAgents.join(", ")}]`;
    }
}

/**
 * 发布一个任务到指定 Agent。
 * 任务存储在 Router 中，目标 Agent 可通过 get_task 工具（轮询模式）获取并执行。
 */
export class PublishTaskTool extends BaseTool {
    name = "publish_task";
    description =
        "发布一个任务到指定 Agent。任务状态初始为 pending，目标 Agent 可通过 get_task 获取。支持设置 nextTasks 实现链式工作流。";

    parameters: ToolParam[] = [
        {
            name: "to",
            type: "string",
            description: "目标 Agent 名称（必须先通过 register_agent 注册）",
            required: true,
        },
        {
            name: "from",
            type: "string",
            description: "来源 Agent 名称，标明任务由谁发起",
            required: true,
        },
        {
            name: "type",
            type: "string",
            description: "任务类型标签，如 'code'、'review'、'fix'、'test'",
            required: true,
        },
        {
            name: "payload",
            type: "string",
            description: "任务携带的数据，JSON 字符串格式。例如 '{\"file\": \"src/a.ts\", \"issue\": \"类型错误\"}'",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const to = args["to"] as string;
        const from = args["from"] as string;
        const type = args["type"] as string;
        const payloadStr = args["payload"] as string;

        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(payloadStr) as Record<string, unknown>;
        } catch {
            return `❌ 错误: payload 不是合法的 JSON 字符串。收到: ${payloadStr}`;
        }

        const id = router.publish({ to, from, type, payload });
        const pending = router.pendingCount(to);

        return [
            `📨 任务已发布`,
            `  ID:     ${id}`,
            `  目标:   ${to}`,
            `  类型:   ${type}`,
            `  来源:   ${from}`,
            `  负载:   ${payloadStr}`,
            `  ${to} 待处理: ${pending} 个任务`,
        ].join("\n");
    }
}

/**
 * 轮询获取指定 Agent 的下一个待处理任务。
 * 返回的任务自动标记为 in_progress。
 */
export class GetTaskTool extends BaseTool {
    name = "get_task";
    description =
        "轮询获取指定 Agent 的下一个 pending 任务。返回的任务会自动标记为 in_progress。若无待处理任务则返回提示。";

    parameters: ToolParam[] = [
        {
            name: "agent",
            type: "string",
            description: "Agent 名称，查询该 Agent 的待处理任务",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const agent = args["agent"] as string;
        const task = router.getTask(agent);

        if (!task) {
            return `⏳ Agent "${agent}" 当前无待处理任务。`;
        }

        return [
            `📋 获取任务`,
            `  ID:      ${task.id}`,
            `  目标:    ${task.to}`,
            `  来源:    ${task.from}`,
            `  类型:    ${task.type}`,
            `  负载:    ${JSON.stringify(task.payload)}`,
            `  状态:    ${task.status}`,
            `  创建时间: ${new Date(task.createdAt).toLocaleString("zh-CN")}`,
        ].join("\n");
    }
}

/**
 * 标记任务为完成，并存储结果。
 * 如果任务定义了 nextTasks，会自动链式发布后续任务。
 */
export class CompleteTaskTool extends BaseTool {
    name = "complete_task";
    description =
        "标记指定任务为完成并存储结果。如果该任务设置了 nextTasks，会自动发布后续任务。";

    parameters: ToolParam[] = [
        {
            name: "id",
            type: "string",
            description: "要完成的任务 ID",
            required: true,
        },
        {
            name: "result",
            type: "string",
            description: "任务执行结果，JSON 字符串格式",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const id = args["id"] as string;
        const resultStr = args["result"] as string;

        let result: Record<string, unknown>;
        try {
            result = JSON.parse(resultStr) as Record<string, unknown>;
        } catch {
            return `❌ 错误: result 不是合法的 JSON 字符串。收到: ${resultStr}`;
        }

        const task = router.getTaskById(id);
        if (!task) {
            return `❌ 错误: 任务 "${id}" 不存在。`;
        }

        router.complete(id, result);
        return `✅ 任务 "${id}" 已完成。类型: ${task.type}, 来源: ${task.from} → 目标: ${task.to}`;
    }
}

/**
 * 查询任务列表或单个任务。
 * 支持按目标 Agent、状态等过滤条件查询。
 */
export class QueryTasksTool extends BaseTool {
    name = "query_tasks";
    description =
        "查询任务列表。可按目标 Agent、状态等条件过滤，或按 ID 查询单个任务。";

    parameters: ToolParam[] = [
        {
            name: "id",
            type: "string",
            description: "按任务 ID 查询单个任务。提供此参数时忽略其他过滤条件。",
        },
        {
            name: "to",
            type: "string",
            description: "按目标 Agent 名称过滤",
        },
        {
            name: "from",
            type: "string",
            description: "按来源 Agent 名称过滤",
        },
        {
            name: "status",
            type: "string",
            description: "按任务状态过滤: 'pending' | 'in_progress' | 'completed' | 'failed'",
            enum: ["pending", "in_progress", "completed", "failed"],
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const id = args["id"] as string | undefined;
        const to = args["to"] as string | undefined;
        const from = args["from"] as string | undefined;
        const status = args["status"] as string | undefined;

        // 按 ID 查询单个任务
        if (id) {
            const task = router.getTaskById(id);
            if (!task) {
                return `❌ 任务 "${id}" 不存在。`;
            }
            return [
                `📋 任务详情`,
                `  ID:      ${task.id}`,
                `  目标:    ${task.to}`,
                `  来源:    ${task.from}`,
                `  类型:    ${task.type}`,
                `  状态:    ${task.status}`,
                `  负载:    ${JSON.stringify(task.payload)}`,
                ...(task.result ? [`  结果:    ${JSON.stringify(task.result)}`] : []),
                ...(task.error ? [`  错误:    ${task.error}`] : []),
                `  创建:    ${new Date(task.createdAt).toLocaleString("zh-CN")}`,
                `  更新:    ${new Date(task.updatedAt).toLocaleString("zh-CN")}`,
            ].join("\n");
        }

        // 列表查询
        const tasks = router.getTasks({
            ...(to ? { to } : {}),
            ...(from ? { from } : {}),
            ...(status ? { status: status as "pending" | "in_progress" | "completed" | "failed" } : {}),
        });

        if (tasks.length === 0) {
            return `📭 无匹配任务。注册的 Agent: [${router.registeredAgents.join(", ") || "无"}]，总任务数: ${router.totalTasks}`;
        }

        const lines = [
            `📋 任务列表（共 ${tasks.length} 条）`,
            `  已注册 Agent: [${router.registeredAgents.join(", ") || "无"}]`,
            "",
        ];

        for (const t of tasks) {
            const statusIcon =
                t.status === "completed" ? "✅" :
                t.status === "failed" ? "❌" :
                t.status === "in_progress" ? "🔄" : "⏳";
            lines.push(`  ${statusIcon} ${t.id} | ${t.from} → ${t.to} | ${t.type} | ${t.status}`);
        }

        return lines.join("\n");
    }
}
