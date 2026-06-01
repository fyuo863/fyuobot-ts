// src/agent/runtime.ts
import { Router } from "../router/router.js";
import { Agent } from "./agent.js";
import type { AgentConfig, AgentStatus } from "./agent.js";
import { ShellTool } from "../tools/shell-tool.js";
import { FileTool } from "../tools/file-tool.js";
import { PublishTaskTool } from "../tools/router-tool.js";

/**
 * Agent 运行时 —— 统一管理多个 Agent 的创建和状态查询。
 *
 * Agent 不再自主轮询，由上层（agentLogic）通过 runTask() 调度执行。
 *
 * 典型用法：
 *   const runtime = AgentRuntime.createDefault(sharedRouter);
 *   const agent = runtime.get("coder");
 *   const result = await agent.runTask(task);
 */
export class AgentRuntime {
    private agents = new Map<string, Agent>();
    private router: Router;

    constructor(router: Router) {
        this.router = router;
    }

    // ── Agent 管理 ────────────────────────────────────────

    /** 根据配置创建并注册一个 Agent（自动注册到 Router）。
     *  Agent 不再自主轮询，由上层调度 runTask() 执行。 */
    create(config: AgentConfig): Agent {
        const agent = new Agent(config, this.router);
        this.agents.set(config.name, agent);
        return agent;
    }

    /** 获取单个 Agent */
    get(name: string): Agent | undefined {
        return this.agents.get(name);
    }

    /** 获取所有 Agent 的即时状态快照 */
    getAllStatus(): AgentStatus[] {
        return [...this.agents.values()].map((a) => a.status);
    }

    get agentCount(): number {
        return this.agents.size;
    }

    // ── 预定义配置 ────────────────────────────────────────

    /**
     * 创建默认的工作流 Agent 组合：
     * - coder:    编码 Agent，拥有 shell + file + publish_task 工具，
     *             完成编码后可主动发布 review 任务给 reviewer
     * - reviewer: 审查 Agent，拥有 file + publish_task 工具，
     *             审查发现问题后可主动发布 fix 任务给 coder
     *
     * 两者通过共享 Router 交换数据，形成闭环协作：
     *   用户 → publish_task(to: "coder") → coder 自主编码 →
     *   publish_task(to: "reviewer") → reviewer 自主审查 →
     *   publish_task(to: "coder") → coder 修复 → ... → 完成
     */
    static createDefault(router: Router): AgentRuntime {
        const runtime = new AgentRuntime(router);

        // ── Coder ──
        runtime.create({
            name: "coder",
            systemPrompt: [
                "你是一个专业的程序员，负责编写和修改代码。",
                "",
                "你的工具：",
                "- execute_bash: 执行终端命令（ls, npm, git, tsc 等）",
                "- file_operator: 读写本地文件",
                "- publish_task: 发布任务给其他 Agent",
                "",
                "规则：",
                "- 收到编码任务后，先理解需求，再动手",
                "- 修改文件前先用 file_operator 读取原始内容",
                "- 每次工具调用后，根据结果决定下一步",
                "- 编码完成后，使用 publish_task 发布 review 任务给 reviewer：",
                "  to=\"reviewer\", from=\"coder\", type=\"review\", payload={\"files\": [...], \"summary\": \"...\"}",
                "- 收到 reviewer 返回的 fix 任务后，根据审查意见修改代码",
                "- 任务完成后简要说明你做了什么",
            ].join("\n"),
            tools: [new ShellTool(), new FileTool(), new PublishTaskTool()],
        });

        // ── Reviewer ──
        runtime.create({
            name: "reviewer",
            systemPrompt: [
                "你是一个严谨的代码审查员，负责检查代码质量。",
                "",
                "你的工具：",
                "- file_operator: 读取文件内容",
                "- publish_task: 发布任务给其他 Agent",
                "",
                "审查重点：",
                "- 逻辑正确性：代码是否按预期工作",
                "- 类型安全：TypeScript 类型是否准确",
                "- 边界情况：空值、异常、并发等处理",
                "- 可读性：命名、结构、注释是否清晰",
                "",
                "规则：",
                "- 先读取文件，再给出审查意见",
                "- 对每个问题给出具体位置和改进建议",
                "- 如果代码质量合格，直接标记任务完成",
                "- 如果发现问题，使用 publish_task 发布 fix 任务给 coder：",
                "  to=\"coder\", from=\"reviewer\", type=\"fix\", payload={\"files\": [...], \"issues\": [{...}]}",
                "- 任务完成后汇总发现的问题",
            ].join("\n"),
            tools: [new FileTool(), new PublishTaskTool()],
        });

        return runtime;
    }
}
