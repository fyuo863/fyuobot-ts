// src/agent/runtime.ts
import { Router } from "../router/router.js";
import { Agent } from "./agent.js";
import type { AgentConfig, AgentStatus } from "./agent.js";
import { ShellTool } from "../tools/shell-tool.js";
import { FileTool } from "../tools/file-tool.js";

/**
 * Agent 运行时 —— 统一管理多个 Agent 的创建、启停和状态查询。
 *
 * 典型用法：
 *   const runtime = AgentRuntime.createDefault(sharedRouter);
 *   runtime.startAll();
 *   // ... TUI 渲染 ...
 *   runtime.stopAll();
 */
export class AgentRuntime {
    private agents = new Map<string, Agent>();
    private router: Router;

    constructor(router: Router) {
        this.router = router;
    }

    // ── Agent 管理 ────────────────────────────────────────

    /** 根据配置创建并注册一个 Agent（自动注册到 Router） */
    create(config: AgentConfig): Agent {
        const agent = new Agent(config, this.router);
        this.agents.set(config.name, agent);
        return agent;
    }

    /** 启动所有已注册 Agent 的轮询循环 */
    startAll(): void {
        for (const agent of this.agents.values()) {
            agent.start();
        }
    }

    /** 停止所有 Agent */
    stopAll(): void {
        for (const agent of this.agents.values()) {
            agent.stop();
        }
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
     * - coder:    编码 Agent，拥有 shell + file 工具
     * - reviewer: 审查 Agent，拥有 file（只读）工具
     *
     * 两者通过共享 Router 交换数据：
     *   用户 → publish_task(to: "coder") → coder 自主执行 →
     *   nextTasks 链式触发 → reviewer 自主审查 → 完成
     */
    static createDefault(router: Router): AgentRuntime {
        const runtime = new AgentRuntime(router);

        // ── Coder ──
        runtime.create({
            name: "coder",
            systemPrompt: [
                "你是一个专业的 TypeScript 程序员，负责编写和修改代码。",
                "",
                "你的工具：",
                "- execute_bash: 执行终端命令（ls, npm, git, tsc 等）",
                "- file_operator: 读写本地文件",
                "",
                "规则：",
                "- 收到编码任务后，先理解需求，再动手",
                "- 修改文件前先用 file_operator 读取原始内容",
                "- 每次工具调用后，根据结果决定下一步",
                "- 任务完成后简要说明你做了什么",
            ].join("\n"),
            tools: [new ShellTool(), new FileTool()],
        });

        // ── Reviewer ──
        runtime.create({
            name: "reviewer",
            systemPrompt: [
                "你是一个严谨的代码审查员，负责检查代码质量。",
                "",
                "你的工具：",
                "- file_operator: 读取文件内容",
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
                "- 任务完成后汇总发现的问题",
            ].join("\n"),
            tools: [new FileTool()],
        });

        return runtime;
    }
}
