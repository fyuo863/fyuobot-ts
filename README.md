<div align="center">
  <img width="302" height="109" alt="image" src="https://github.com/user-attachments/assets/71623e51-9e15-4d2f-876f-c8d934fcff1c" />
</div>

# fyuobot — 终端 AI 助手

一个基于 TypeScript 的终端 Agent/TUI，面向代码任务、工具调用、MCP 扩展、记忆管理与子 Agent 协作。

它的设计目标不是“聊天壳”，而是一个可演化的本地 Agent 运行时：

- 通过 OpenAI 兼容接口调用模型
- 将本地工具、外挂工具、Skills、MCP 工具统一注册到同一工具平面
- 用事件驱动方式连接 Agent、TUI、子 Agent 与后台任务
- 用热缓冲 + 冷归档 + 长期记忆文件管理上下文
- 允许未来让 Agent 自行构建、测试并热更新工具

<div align="center">
  <br/>
  <img width="800" alt="image" src="public/image.png" />
</div>

## 项目定位

fyuobot 当前是一个“终端中的可扩展 Agent 宿主”，核心能力包括：

- TUI 交互
- 流式 LLM 会话
- 工具调用循环
- 动态工具发现
- 工具热更新
- Skills 转工具
- Slash Commands
- MCP 远程工具注入
- 事件总线 / A2A 子 Agent 协议
- 分层记忆与自动浓缩


## 快速上手

### 环境要求

- Node.js 18+
- npm

### 安装

```bash
git clone https://github.com/fyuo863/fyuobot_ts
cd fyuobot_ts
npm install
```

如需全局命令：

```bash
npm link
```

之后可直接运行：

```bash
fyuo
```

### 环境变量

创建 `.env`：

```env
THIRD_PARTY_API_KEY=sk-your-key-here
THIRD_PARTY_BASE_URL=https://api.deepseek.com
THIRD_PARTY_MODEL=deepseek-v4-flash
```

说明：

- `THIRD_PARTY_API_KEY`：必填
- `THIRD_PARTY_BASE_URL`：OpenAI 兼容接口地址
- `THIRD_PARTY_MODEL`：默认模型名

项目依赖 OpenAI 兼容 API，不绑定某一家模型提供方。

## 配置目录

| 路径 | 用途 |
|------|------|
| `.env` | 模型与接口配置 |
| `.fyuobot/mcp.json` | MCP 服务器配置 |
| `.fyuobot/tools/` | 项目本地外挂工具 |
| `.fyuobot/skills/` | 项目本地 Skills |
| `.fyuobot/slash/` | 项目本地 Slash Commands |
| `.fyuobot/history/` | `history.db` 自动历史与每日活动记录 |
| `.fyuobot/memories/` | `USER.md` / `MEMORY.md` |

用户全局目录也支持同结构扩展：

- `~/.fyuobot/tools/`
- `~/.fyuobot/skills/`
- `~/.fyuobot/slash/`
- `~/.fyuobot/mcp.json`

## MCP 配置示例

`.fyuobot/mcp.json`：

```json
{
  "mcpServers": [
    {
      "name": "codegraph",
      "transport": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"],
      "enabled": true
    }
  ]
}
```

启动时会：

1. 读取项目本地 `.fyuobot/mcp.json`
2. 若不存在则回退到 `~/.fyuobot/mcp.json`
3. 连接 MCP 服务器
4. 发现远程工具
5. 将远程工具合并进主工具注册表

同名冲突时，本地工具优先。

## 启动流程

当前实际启动路径在 [`src/tui/index.tsx`](D:\Program Data\Github Program\.ts\ts-learn\src\tui\index.tsx)。

完整流程大致如下：

1. 初始化 `HistoryManager`
2. 加载 MCP 配置并连接远程工具
3. 加载内置工具、外挂工具与 Skills
4. 自动处理外挂工具依赖
5. 加载内置与外挂 Slash Commands
6. 创建 `AgentRuntime`
7. 启动 `EventLoop`
8. 注册外部查询、子 Agent、A2A 结果处理器
9. 初始化所有工具生命周期 `onInit()`
10. 启动工具热更新监听
11. 打印终端头部信息
12. 挂载 React Ink UI

这意味着 fyuobot 不是“单个 agent.ts 文件直接跑起来”的结构，而是：

- 运行时层负责生命周期
- 事件循环负责系统通信
- 工具层负责能力注入
- UI 只是其中一个消费者

## 整体架构

| 层级 | 模块 | 作用 |
|------|------|------|
| 表现层 | `src/tui/` | React Ink TUI、Markdown、颜色、超链接、确认框 |
| Agent 层 | `src/agent/` | prompt 构建、任务循环、事件桥接、运行时 |
| LLM 层 | `src/llm/` | OpenAI 兼容调用、token 统计 |
| 中间层 | `src/middleware/` | 多提供方 usage 归一化 |
| 工具层 | `src/tools/` | 内置工具、动态注册、热更新、子 Agent、Skill loader |
| 记忆层 | `src/memory/` | 历史缓冲、SQLite 归档、长期记忆整理 |
| 协议层 | `src/mcp/` | MCP 客户端与远程工具注入 |
| 命令层 | `src/slash/` | Slash Commands 自动发现与路由 |

## 项目结构

```text
src/
  agent/
    agent.ts
    agent-task.ts
    agentLogic.ts
    event-bridge.ts
    event-loop.ts
    event-server.ts
    events.ts
    message-queue.ts
    prompts.ts
    runtime.ts
    stream.ts
    tool-executor.ts
  llm/
    llm.ts
    tokens.ts
  mcp/
    mcp.ts
  memory/
    history-manager.ts
  middleware/
    index.ts
    provider.ts
    providers/
    types.ts
  slash/
    commands/
    registry.ts
    types.ts
  tools/
    basetool.ts
    calculator.ts
    compress-tool.ts
    shell-tool.ts
    sub-agent-tool.ts
    time-tool.ts
    tool-hot-reload.ts
    tool-loader.ts
    database/
    file/
    memory/
    skill/
  tui/
    colors.tsx
    confirm.tsx
    header.ts
    index.tsx
    linkify.ts
    markdown.tsx
    ui.tsx
```

## Agent 运行模型

### 1. 单轮任务如何执行

当前主 Agent 的执行模型是：

1. 构建消息上下文
2. 调用 LLM
3. 解析 tool calls
4. 询问用户是否批准危险工具
5. 执行工具
6. 把工具结果回送给 LLM
7. 重复直到模型不再请求工具
8. 保存结果到历史
9. 检查是否需要浓缩

这部分主要在：

- [`src/agent/agent.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\agent\agent.ts)
- [`src/agent/agent-task.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\agent\agent-task.ts)

### 2. AgentRuntime

[`src/agent/runtime.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\agent\runtime.ts) 当前提供默认的单 Agent 运行时，负责组装：

- `Agent`
- `MessageQueue`
- `EventLoop`

当前默认 Agent 名为 `fyuobot`。

### 3. StreamingSession

[`src/agent/stream.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\agent\stream.ts) 提供了一个框架无关的流式会话层：

- 维护自己的消息上下文
- 维护本轮响应与 token 统计
- 通过 `EventLoop` 对外广播流事件
- 可被 TUI、HTTP SSE、WebSocket 等消费者复用

这部分是项目从“TUI 逻辑和会话逻辑耦合”向“会话层独立”演进的重要一步。

## Prompt 构建与缓存命中

当前 prompt 构建逻辑在 [`src/agent/prompts.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\agent\prompts.ts)。

核心顺序是：

1. Agent identity
2. `USER.md`
3. `MEMORY.md`
4. 核心 system prompt
5. 额外系统消息
6. 当前用户输入

这个顺序的意图是：

- 把更稳定的上下文前置
- 把更易变化的内容后置
- 尽量提高 prompt cache 命中率

当前 prompt 中还内置了明确的记忆写入边界规则，尤其区分：

- 用户个人长期偏好应该进入 `USER.md`
- 系统 / 项目 / 工具 / Agent / 工作流规则应该进入 `MEMORY.md`

## 事件系统

### 1. EventLoop

[`src/agent/event-loop.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\agent\event-loop.ts) 是当前系统的中央事件循环：

- 消费 `MessageQueue`
- 经过中间件链
- 分发给特定事件处理器与通配符处理器
- 支持超时保护
- 默认可在处理器报错后继续运行

### 2. 事件类型

[`src/agent/events.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\agent\events.ts) 定义了统一的事件类型，主要包括：

- Agent 生命周期事件
- 用户输入事件
- LLM 请求与响应事件
- 工具执行事件
- 任务状态事件
- 流式输出事件
- Token 统计事件
- 历史保存事件
- 子 Agent / A2A 事件

这让 UI、后台任务、子 Agent 推送不必直接相互调用，而是通过事件协作。

## 工具系统

### 1. 工具注册模型

所有工具都继承 [`BaseTool`](D:\Program Data\Github Program\.ts\ts-learn\src\tools\basetool.ts)。

工具系统提供：

- 自动发现
- 动态导入
- 子目录扫描
- 生命周期钩子
- 并发键控制
- 过滤注册表
- OpenAI tool schema 导出

### 2. 加载优先级

当前工具加载入口在 [`src/tools/tool-loader.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\tools\tool-loader.ts)。

加载来源：

1. 内置工具 `src/tools/`
2. 项目本地外挂工具 `.fyuobot/tools/`
3. 用户全局外挂工具 `~/.fyuobot/tools/`
4. Skills 转换得到的动态工具
5. MCP 远程工具

### 3. 外挂工具依赖安装

项目支持为外挂工具自动安装依赖：

- 项目本地外挂工具可以把依赖合并到根 `package.json`
- 全局外挂工具可以在各自目录独立安装

这部分能力在 README 里很值得强调，因为它让“本地挂工具”变成低门槛操作，而不是手工改主仓库。

## 当前内置工具

当前实际内置核心工具包括：

| 工具名 | 文件 | 作用 |
|------|------|------|
| `execute_command` | `src/tools/shell-tool.ts` | 执行命令，支持 `cwd`、超时、后台运行、输出截断 |
| `file_operator` | `src/tools/file/file-operator-tool.ts` | 文本文件读写，支持 `read`/`write`/`append`/`replace`/`delete` |
| `read_file_lines` | `src/tools/file/read-lines-tool.ts` | 按行范围读取文件 |
| `read_file_symbols` | `src/tools/file/read-symbols-tool.ts` | 提取顶层符号 |
| `db_read` | `src/tools/database/db-read-tool.ts` | 只读访问 SQLite |
| `memory` | `src/tools/memory/memory-tool.ts` | 读写记忆文件、搜索历史归档、查看统计 |
| `compress` | `src/tools/compress-tool.ts` | 压缩记忆文件、触发历史归档 |
| `calculator` | `src/tools/calculator.ts` | 数学计算 |
| `get_current_time` | `src/tools/time-tool.ts` | 获取当前时间 |
| `delegate_task` | `src/tools/sub-agent-tool.ts` | 委派任务给子 Agent |

注意：

- 旧文档里如果出现 `shell`、`time` 之类旧工具名，当前实现已经不是这些名字。
- `_test` 目录下的工具不会被正常发现加载，它们不应写进面向用户的工具清单。

### 4. 危险操作确认

工具可以通过两种方式标记确认策略：

- `dangerous = true`
- `requiresConfirmation(args)`

当前典型例子：

- `execute_command` 默认危险
- `file_operator` 中 `read` 不需要确认，但写类操作需要确认

## 工具热更新

热更新实现位于 [`src/tools/tool-hot-reload.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\tools\tool-hot-reload.ts)。

当前语义很重要：

- 监听工具目录和 Skill 目录
- 发生文件变化后，后台重建候选注册表
- 不会中断当前轮对话
- 只在下一轮 `runTask()` 开始前应用
- 如果新旧 schema 完全一致，则取消这次待更新
- 如果新结果和已经 pending 的更新一致，则忽略重复重建

换句话说：

- 热更新不是每轮对话都会触发
- 热更新是“文件变化触发，下一轮生效”
- 这是为“Agent 自建工具”准备的保守策略，尽量减少上下文抖动

### 热更新对缓存命中的影响

这个项目未来要支持 Agent 自建工具，所以热更新不是可选项。

当前策略对缓存的影响是：

- 如果工具文件变了，但导出的 tool schema 没变，则不会制造无意义的下一轮 schema 抖动
- 如果 schema 变了，下一轮缓存前缀自然可能失效，这属于真实能力变化带来的成本
- 由于是“下一轮应用”，至少不会在当前轮中途把工具定义切掉

这是一种“优先稳定当前轮、允许下一轮增量演化”的设计。

## Skills 系统

Skills 本质上是 `SKILL.md` 驱动的 SOP / 知识模块，当前由 [`src/tools/skill/`](D:\Program Data\Github Program\.ts\ts-learn\src\tools\skill) 负责加载。

加载来源：

1. 内置 `src/tools/skill/builtin/`
2. 项目本地 `.fyuobot/skills/`
3. 用户全局 `~/.fyuobot/skills/`

当前 Skill 会被转换成动态工具，面向模型暴露。

### 渐进式披露

Skill 的设计不是一开始把全文塞进上下文，而是分层披露：

- L1：工具描述
- L2：执行摘要
- L3：完整正文

这样做的好处是：

- 工具列表阶段只占很少 token
- 真正需要时再取更多内容
- 更适合和 prompt cache 一起工作

## Slash Commands

Slash Commands 位于：

- 内置：`src/slash/commands/`
- 项目本地：`.fyuobot/slash/`
- 用户全局：`~/.fyuobot/slash/`

当前内置命令：

- `/clean`
- `/new`

Slash 注册表支持：

- 自动发现
- 别名
- 模糊搜索
- 补全

## 子 Agent 与 A2A

子 Agent 相关逻辑当前主要在 [`src/tools/sub-agent-tool.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\tools\sub-agent-tool.ts)。

### 1. 当前能力

`delegate_task` 支持两种模式：

- `wait=true`
  立即等待子 Agent 完成并返回结果

- `wait=false`
  后台运行，完成后把结果推送回主 Agent 的消息队列

另外还支持：

- `action="drain_results"` 手动排出已完成的后台结果

### 2. 工具暴露策略

当前子 Agent 不是天然看见主 Agent 全部工具，而是通过过滤注册表拿到一份允许工具子集：

- 显式传入 `allowed_tools`
- 或根据任务文本推断最小必要工具集

默认基础工具包括：

- `read_file_symbols`
- `read_file_lines`
- `calculator`
- `get_current_time`

再按任务内容按需放开：

- 文件编辑类工具
- shell 工具
- 数据库工具
- 记忆工具
- 委派工具

这说明项目当前已经走向“按需暴露”而不是“全量可见但少用”。

### 3. 后台结果回流

后台子 Agent 完成后，会通过 A2A 事件推送结果。主 Agent 下一轮构建上下文时，会把这些已完成结果作为额外系统消息注入。

这个机制不是轮询，而是事件推送 + 下一轮消费。

## 记忆系统

### 1. 分层结构

当前记忆系统分三类：

- `history.db`
  程序自动写入的情节记忆，保存每轮日期、24 小时时间、用户本轮初始提问、调用工具、agent 最终回复，并派生每日活动记录

- `USER.md`
  用户个人长期稳定事实

- `MEMORY.md`
  系统 / 项目 / 工具 / 工作流长期规则

一轮的边界定义为：agent 完成输出并再次轮到用户输入。

### 2. 当前语义边界

`USER.md` 适合写：

- 语言偏好
- 沟通风格
- 审批偏好
- 个人习惯
- 稳定开发偏好

`MEMORY.md` 适合写：

- 架构决策
- 工具注册规则
- 子 Agent 策略
- 热更新策略
- 记忆写入规范
- 项目级长期约束

如果不确定写到哪里，优先 `MEMORY.md`。

### 3. memory 工具的写入防线

当前 `memory` 工具已经加强了错误写入防线：

- 如果要写进 `USER.md` 的内容更像系统规则/项目规则/工具规则，会直接拒绝
- prompt 里也有同样规则

这部分是为了避免把本该属于 `MEMORY.md` 的内容污染到用户个人记忆。

### 4. 自动记录与压缩

当前阈值：

- `USER.md` / `MEMORY.md`：`50 KB`

当前行为：

- `history.db` 由程序逐轮结构化写入，不依赖 agent 主动总结
- `USER.md` / `MEMORY.md` 超阈值后，按结构做压缩

### 5. USER.md 结构化合并

当前 `USER.md` 会被整理为这些分区：

- `Current Preferences`
- `Environment`
- `Projects`
- `Historical Notes`

这让长期记忆不只是“追加文本”，而是逐步结构化。

## SQLite 历史归档

当前 SQLite 数据库使用 `node:sqlite`。

保存内容包括：

- `turns`：原始轮次记录
- `daily_activities`：按日期查询“某天做了什么”的活动记录

可以通过 `memory(recent/day/search/stats)` 和 `db_read` 两种方式查看：

- `memory` 更偏 Agent 记忆语义
- `db_read` 更偏结构化数据库探查

## TUI 界面

当前 TUI 基于 React 19 + Ink 7，主要功能包括：

- ASCII 头部
- Markdown 渲染
- 颜色自适应
- 文件路径 / URL 超链接
- 历史面板
- 思考与回答分离显示
- 工具调用过程展示
- 危险操作确认框

这部分主要位于：

- [`src/tui/ui.tsx`](D:\Program Data\Github Program\.ts\ts-learn\src\tui\ui.tsx)
- [`src/tui/confirm.tsx`](D:\Program Data\Github Program\.ts\ts-learn\src\tui\confirm.tsx)
- [`src/tui/markdown.tsx`](D:\Program Data\Github Program\.ts\ts-learn\src\tui\markdown.tsx)
- [`src/tui/linkify.ts`](D:\Program Data\Github Program\.ts\ts-learn\src\tui\linkify.ts)

## 多提供方中间层

[`src/middleware/`](D:\Program Data\Github Program\.ts\ts-learn\src\middleware) 当前负责 usage 归一化。

目标是：

- 兼容不同提供商响应结构
- 统一 token 统计
- 支持缓存命中/未命中展示

当前已考虑：

- OpenAI
- DeepSeek
- Anthropic

## 自定义工具

### 新增内置工具

在 `src/tools/` 或其子目录新增继承 `BaseTool` 的类即可。

### 新增项目本地外挂工具

放到：

```text
.fyuobot/tools/<your-tool>/
```

如带 `package.json`，启动时会尝试自动处理依赖。

### 最小示例

```ts
import { BaseTool, type ToolParam } from "./basetool.js";

export class MyTool extends BaseTool {
    name = "my_tool";
    description = "我的自定义工具";
    parameters: ToolParam[] = [
        { name: "input", type: "string", description: "输入", required: true },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        return `结果: ${args.input}`;
    }
}
```

## 自定义 Skill

放到：

```text
.fyuobot/skills/<skill-name>/SKILL.md
```

## 自定义 Slash Command

放到：

```text
.fyuobot/slash/
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js + tsx |
| TUI | React 19 + Ink 7 |
| LLM SDK | openai 6.x |
| Markdown | marked + marked-terminal |
| 页面提取 | jsdom + @mozilla/readability + turndown |
| 浏览与抓取 | Puppeteer |
| 记忆归档 | SQLite (`node:sqlite`) |
| MCP | 自研 JSON-RPC 2.0 客户端 |

## 已知事项

- `node:sqlite` 的 ExperimentalWarning 来自 Node 自身，不代表这里的逻辑错误
- 某些使用 `shell: true` 的子进程可能触发 Node 的安全弃用警告，这通常与依赖安装或子进程封装方式有关
- 代码库内部仍有部分历史中文注释乱码，但不影响当前 README 内容
