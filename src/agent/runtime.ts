// src/agent/runtime.ts
import { Agent } from "./agent.js";
import type { AgentConfig, AgentStatus } from "./agent.js";
import type { ToolRegistry } from "../tools/basetool.js";
import { CORE_SYSTEM_PROMPT, buildAgentIdentity } from "./prompts.js";

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
            // Layer 1: 核心系统提示词（最稳定 → 缓存前缀）
            systemPrompt: CORE_SYSTEM_PROMPT,
            // Layer 2: Agent 身份设定（按 agent 变化）
            identity: buildAgentIdentity("fyuobot"),
        };

        const agent = new Agent(config, registry);
        return new AgentRuntime(agent);
    }
}
