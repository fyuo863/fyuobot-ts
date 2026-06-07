// src/agent/runtime.ts
import { Agent } from "./agent.js";
import type { AgentConfig, AgentStatus } from "./agent.js";
import type { ToolRegistry } from "../tools/basetool.js";
import { CORE_SYSTEM_PROMPT, buildAgentIdentity } from "./prompts.js";
import { MessageQueue } from "./message-queue.js";
import { EventLoop } from "./event-loop.js";

/**
 * Agent 运行时 —— 管理 Agent、MessageQueue 和 EventLoop 的生命周期。
 *
 * 典型用法：
 *   const runtime = AgentRuntime.createDefault(registry);
 *   runtime.start();  // 启动事件循环
 *   const agent = runtime.getDefault();
 *   const result = await agent.runTask("帮我写一个函数");
 *   await runtime.stop();  // 优雅关闭
 */
export class AgentRuntime {
    private agent: Agent;
    private bus: MessageQueue;
    private loop: EventLoop;

    constructor(agent: Agent, bus: MessageQueue, loop: EventLoop) {
        this.agent = agent;
        this.bus = bus;
        this.loop = loop;
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

    // ── 事件系统访问 ─────────────────────────────────────

    /** 获取事件循环（用于注册处理器和中间件） */
    getEventLoop(): EventLoop {
        return this.loop;
    }

    /** 获取消息队列（用于直接发出事件） */
    getMessageQueue(): MessageQueue {
        return this.bus;
    }

    // ── 生命周期 ──────────────────────────────────────────

    /** 启动事件循环。在挂载 UI 之前调用。 */
    start(): void {
        this.loop.start();
    }

    /** 优雅关闭事件循环。在 UI 卸载时调用。 */
    async stop(): Promise<void> {
        await this.loop.stop();
    }

    // ── 预定义配置 ────────────────────────────────────────

    /**
     * 创建默认的单 Agent 运行时。
     * 同时创建 MessageQueue 和 EventLoop，并组装完整的 Agent。
     *
     * Agent 拥有所有已发现工具（shell、file 等），直接响应用户的编程需求。
     */
    static createDefault(registry: ToolRegistry): AgentRuntime {
        const bus = new MessageQueue();
        const loop = new EventLoop(bus);

        const config: AgentConfig = {
            name: "fyuobot",
            // Layer 1: 核心系统提示词（最稳定 → 缓存前缀）
            systemPrompt: CORE_SYSTEM_PROMPT,
            // Layer 2: Agent 身份设定（按 agent 变化）
            identity: buildAgentIdentity("fyuobot"),
        };

        const agent = new Agent(config, registry, bus);
        return new AgentRuntime(agent, bus, loop);
    }
}
