// src/agent/runtime.ts
import { Agent } from "./agent.js";
import type { AgentConfig, AgentStatus } from "./agent.js";
import type { ToolRegistry } from "../tools/basetool.js";

/**
 * Agent 运行时 —— 管理单 Agent 的创建和状态查询。
 *
 * 典型用法：
 *   const runtime = AgentRuntime.createDefault(registry);
 *   const agent = runtime.getDefault();
 *   const result = await agent.runTask("帮我写一个函数");
 */
export class AgentRuntime {
    private agent: Agent;

    constructor(agent: Agent) {
        this.agent = agent;
    }

    // ── Agent 访问 ────────────────────────────────────────

    /** 获取默认 Agent */
    getDefault(): Agent {
        return this.agent;
    }

    /** 获取 Agent 的即时状态快照 */
    getAllStatus(): AgentStatus[] {
        return [this.agent.status];
    }

    get agentCount(): number {
        return 1;
    }

    // ── 预定义配置 ────────────────────────────────────────

    /**
     * 创建默认的单 Agent。
     * Agent 拥有所有已发现工具（shell、file 等），直接响应用户的编程需求。
     */
    static createDefault(registry: ToolRegistry): AgentRuntime {
        const config: AgentConfig = {
            name: "fyuobot",
            systemPrompt: [
                "你是一个专业的编程助手，帮助用户编写、修改和理解代码。",
                "",
                "你的工具：",
                "- execute_bash: 执行终端命令（ls, npm, git, tsc 等）",
                "- file_operator: 读写本地文件",
                "",
                "工作方式：",
                "- 收到用户请求后，先理解需求，再动手",
                "- 修改文件前先用 file_operator 读取原始内容",
                "- 每次工具调用后，根据结果决定下一步",
                "- 任务完成后简要说明你做了什么",
            ].join("\n"),
        };

        const agent = new Agent(config, registry);
        return new AgentRuntime(agent);
    }
}
