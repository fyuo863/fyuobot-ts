<div align="center">
  <img width="302" height="109" alt="image" src="https://github.com/user-attachments/assets/71623e51-9e15-4d2f-876f-c8d934fcff1c" />
</div>

# fyuobot — 终端 AI 助手

一个基于 TypeScript 的终端 AI 助手（TUI），通过 OpenAI 兼容 API 驱动 LLM，支持工具调用、MCP 协议扩展、斜杠命令系统、双层记忆系统和流式交互。

<div align="center">
  <img width="800" alt="image" src="https://github.com/user-attachments/assets/4ff58e6e-b120-49b4-963c-8f28b6fed75c" />
  <br/>
  <br/>
  <img width="800" alt="image" src="https://github.com/user-attachments/assets/fef3633f-8689-437f-80a3-dd689c5c9fcd" />
</div>

## 快速上手

### 环境要求

- Node.js ≥ 18
- npm

### 安装与配置

```bash
# 1. 克隆项目
git clone https://github.com/fyuo863/fyuobot_ts
cd fyuobot_ts

# 2. 安装依赖
npm install

# 3. 注册全局命令（之后在任意目录输入 fyuo 即可启动）
npm link

# 4. 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 API Key
```

### 启动

```bash
fyuo
```

首次启动时如果未配置 `.env`，会在发送第一条消息时给出提示。

### 配置说明

`.env` 文件：

```env
# 你的 API Key（必填）
THIRD_PARTY_API_KEY=sk-your-key-here

# 兼容 OpenAI 接口的平台地址（DeepSeek/OpenAI 等）
THIRD_PARTY_BASE_URL=https://api.deepseek.com

# 模型名称
THIRD_PARTY_MODEL=deepseek-v4-flash
```

### 配置文件

| 文件 | 用途 |
|------|------|
| `.env` | API Key、Base URL、模型配置 |
| `.fyuobot/mcp.json` | MCP 服务器配置 |
| `.fyuobot/tools/` | 外挂工具目录 |
| `.fyuobot/skills/` | 外挂技能目录（SKILL.md） |
| `.fyuobot/slash/` | 外挂斜杠命令目录 |
| `.fyuobot/history/` | 对话历史归档（SQLite） |
| `.fyuobot/memories/` | 用户记忆 / 偏好（HISTORY.md + USER.md） |

### MCP 配置示例

`.fyuobot/mcp.json`：

```json
{
  "mcpServers": [
    {
      "name": "以 codegraph mcp 为例",
      "transport": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"],
      "enabled": true
    }
  ]
}
```

## 工作流程

1. **启动** → 打印 ASCII Logo → 初始化历史管理器 → 自动安装外挂工具依赖 → 自动发现本地工具（含子目录扫描） → 加载外挂工具 → 加载技能工具（内置 + 外挂，渐进式披露）→ 连接 MCP 服务器 → 注入远程工具 → 初始化工具生命周期 → 注册斜杠命令（内置 + 外挂）→ 挂载 React Ink UI
2. **用户输入** → 检测斜杠命令（`/` 前缀触发命令路由，↑↓ 导航选择 / 建议面板） → 构建缓存优化的消息上下文 → 流式调用 LLM
3. **工具调用** → Agent 解析 tool_calls → 检查敏感操作（需要时弹确认框） → 执行工具（带进度回调） → 记录工具调用到历史 → 将结果反馈 LLM
4. **循环** → 重复 2-3 直到 LLM 不再请求工具调用
5. **记录** → 自动追加对话 + 工具调用记录到 HISTORY.md → 超阈值时触发冷归档管道 → LLM 批量浓缩 → 提取用户特征到 USER.md

## 架构概览

| 层级 | 模块 | 说明 |
|------|------|------|
| 🎨 表现层 | **TUI** ([src/tui/](src/tui/)) | React Ink 终端交互界面（Markdown 渲染、OSC 8 超链接、Logo 渲染、确认对话框） |
| 🧠 逻辑层 | **Agent** ([src/agent/](src/agent/)) | Agent 消息构建、工具调用循环、流式会话层（StreamingSession）、提示词分层 |
| ⌨️ 命令层 | **Slash** ([src/slash/](src/slash/)) | 斜杠命令系统（自动发现、模糊搜索、Tab 补全） |
| 🌐 通信层 | **LLM** ([src/llm/](src/llm/)) | OpenAI 兼容流式 API 调用、Token 估算 |
| 🔀 中间层 | **Middleware** ([src/middleware/](src/middleware/)) | 多厂商 Usage 归一化（DeepSeek / OpenAI / Anthropic） |
| 🔧 工具层 | **Tools** ([src/tools/](src/tools/)) | 可插拔工具系统（Shell、文件符号/行读取、数据库读取、记忆、压缩、计算器等），支持生命周期钩子 |
| 🗄️ 记忆层 | **Memory** ([src/memory/](src/memory/)) | 双层对话历史存储（热缓冲 + SQLite 冷归档 + USER.md 特征提取），记录工具调用 |
| 📋 技能层 | **Skill** ([src/tools/skill/](src/tools/skill/)) | SKILL.md → 动态工具转换（渐进式披露：概览 → 细读 → 全文） |
| 🔌 扩展层 | **MCP** ([src/mcp/](src/mcp/)) | MCP 客户端（JSON-RPC 2.0 / stdio / SSE）→ 远程工具注入 |

## 项目结构

```
src/
├── agent/                    # Agent 核心
│   ├── agent.ts              # Agent 类：消息构建 + 工具调用循环
│   ├── agentLogic.ts         # React Hook：驱动 TUI 的完整交互逻辑
│   ├── stream.ts             # StreamingSession：框架无关的流式会话层
│   ├── prompts.ts            # 提示词分层设计（缓存优化）
│   └── runtime.ts            # AgentRuntime：创建与管理 Agent
├── slash/                    # 斜杠命令系统
│   ├── types.ts              # SlashCommand 接口定义
│   ├── registry.ts           # CommandRegistry：自动发现、搜索、补全
│   └── commands/
│       ├── clean.ts          # /clean — 清空屏幕对话历史
│       └── new.ts            # /new — 开始新对话（清屏 + 重置上下文）
├── llm/
│   ├── llm.ts                # OpenAI 兼容流式调用 + 工具调用合并
│   └── tokens.ts             # Token 估算
├── mcp/
│   └── mcp.ts                # MCP 客户端（JSON-RPC 2.0 / stdio / SSE）
├── memory/
│   └── history-manager.ts    # 双层历史管理（HISTORY.md 热缓冲 → SQLite 冷归档 → USER.md 提取）+ 工具调用记录
├── middleware/
│   ├── index.ts              # Provider 注册 + normalizeUsage 入口
│   ├── provider.ts           # detectProvider：自动识别 LLM 厂商
│   ├── types.ts              # 类型定义
│   └── providers/            # DeepSeek / OpenAI / Anthropic 归一化
├── tools/
│   ├── basetool.ts           # BaseTool 抽象类 + ToolRegistry（自动发现 + 生命周期钩子 + 子目录扫描）
│   ├── shell-tool.ts         # 终端命令执行（标记为敏感操作）
│   ├── _file-tool.ts         # [已废弃] 原文件读写工具，已拆分到 file/ 子目录
│   ├── calculator.ts         # 数学计算
│   ├── compress-tool.ts      # HISTORY.md → SQLite 归档管道
│   ├── time-tool.ts          # 时间查询
│   ├── test-tool.ts          # 测试工具
│   ├── database/             # 数据库读取工具
│   │   └── db-read-tool.ts   # SQLite 只读访问（表结构 / SELECT 查询 / 统计）
│   ├── file/                 # 文件读取工具（拆分）
│   │   ├── read-lines-tool.ts   # read_file_lines — 按行号范围精准读取
│   │   └── read-symbols-tool.ts # read_file_symbols — 扫描文件顶级符号及行号
│   ├── memory/               # 记忆工具
│   │   └── memory-tool.ts    # 记忆文件读写 + SQLite 历史搜索
│   └── skill/                # 技能加载器
│       ├── skill-loader.ts   # SKILL.md 解析 → SkillTool 动态生成 + 渐进式披露
│       └── builtin/          # 内置技能（随项目分发）
└── tui/
    ├── index.tsx              # 启动入口（Bootstrap：工具发现 → MCP 连接 → 命令注册 → UI 挂载）
    ├── ui.tsx                 # 主交互界面（含斜杠命令路由和补全面板 + 历史记录面板）
    ├── header.ts              # ASCII Logo 渲染（3D 轴测阴影算法 + 环境信息）
    ├── colors.tsx             # ANSI 颜色模块（真彩色 → 256 色 → 16 色自动降级）
    ├── linkify.ts             # OSC 8 超链接（文件路径 + URL → Ctrl+Click 打开）
    ├── confirm.tsx            # 敏感操作确认对话框
    └── markdown.tsx           # Markdown 渲染
```

## 核心特性

### 🧠 智能 Agent 系统

- **工具调用循环**：Agent 自动在 LLM 推理和工具执行之间循环，直到任务完成
- **框架无关的流式会话层**：[StreamingSession](src/agent/stream.ts) 通过 `StreamHandler` 回调接口将流式事件与 UI 解耦，可被 TUI、HTTP SSE、WebSocket 等任意消费者复用
- **缓存优化的消息排序**：消息按稳定→易变排列（Agent 身份 → USER.md → MEMORY.md → 系统提示词 → 用户查询），最大化 LLM prompt cache 命中率
- **流式响应**：实时逐 token 输出，支持 `<think>` 标签解析（兼容 DeepSeek 等推理模型）
- **敏感操作确认**：标记为 `dangerous` 的工具（如 Shell 命令）执行前需要用户在 TUI 中确认

### ⌨️ 斜杠命令系统

- **自动发现**：`CommandRegistry.discoverAndRegister()` 扫描 `src/slash/commands/`，自动加载所有 `SlashCommand` — 新增命令只需放一个文件
- **模糊搜索 + 上下键选择**：输入 `/` 触发命令模式，显示匹配建议面板，↑↓ 导航选择，Tab 填入选中命令
- **内置命令**：
  | 命令 | 别名 | 功能 |
  |------|------|------|
  | `/clean` | `/cls`, `/clear` | 清空终端上的对话历史显示 |
  | `/new` | — | 开始新对话（清屏 + 重置 LLM 上下文 + 归零 Token 统计） |
- 设计模式与 `ToolRegistry` 保持一致：纯接口 `SlashCommand` + 动态 `import()` 扫描 + 别名支持

### 🔧 可扩展工具系统

- **自动发现**：`ToolRegistry.discoverAndRegister()` 扫描目录，自动发现和注册所有 `BaseTool` 子类 — 新增工具只需放一个文件
- **子目录支持**：工具可按功能放入子目录（如 `file/`、`database/`、`memory/`），`ToolRegistry` 递归扫描并加载
- **生命周期钩子**：工具可实现 `onInit(agent)` / `onDestroy()` 用于启动伴随服务或释放资源
- **依赖自动安装**：外挂工具目录下的 `package.json` 依赖在启动时自动 `npm install`（支持合并到根或独立安装两种模式）
- **外挂工具**：支持从 `.fyuobot/tools/` 加载用户自定义工具（优先级：项目本地 > 用户全局），通过 `mergeFrom()` 合并到主注册表
- **流式进度**：工具执行期间支持 `onProgress` 回调，实时汇报进度到 TUI

**内置工具一览**：

| 工具 | 名称 | 说明 |
|------|------|------|
| Shell | `shell` | 终端命令执行（敏感操作，需确认） |
| 文件符号读取 | `read_file_symbols` | 扫描文件中所有顶级符号（函数/类/接口等）及其行号，支持多语言 |
| 文件行读取 | `read_file_lines` | 按行号范围精准读取文件内容，带行号标注 |
| 数据库读取 | `db_read` | 只读访问 SQLite 数据库（表结构 / SELECT / 统计） |
| 记忆 | `memory` | 记忆文件读写 + SQLite 历史全文搜索 |
| 压缩归档 | `compress` | HISTORY.md → SQLite 冷归档管道（LLM 批量浓缩） |
| 计算器 | `calculator` | 数学表达式计算 |
| 时间 | `time` | 当前时间查询 |
| 技能 | `skill_*` | 动态生成的技能工具（每个 SKILL.md 对应一个工具） |

### 📋 技能系统 (Skills) — 渐进式披露

技能是 "操作手册" 式的知识模块 —— 每个技能将 Markdown 格式的 SOP（标准操作程序）动态转换为 LLM 可调用的工具。采用 **渐进式披露** 策略，技能有三级视图：

| 阶段 | 内容 | 上下文消耗 |
|------|------|-----------|
| **L1 — 工具描述** | 技能名称 + 一句话简介 + 触发时机 | ~50 tokens（注册到 tools 列表） |
| **L2 — 执行摘要** | 提取 SKILL.md 中 `## `、`### `、`- ` 列表，去掉代码块 | ~500 tokens（LLM 调用技能时返回） |
| **L3 — 完整正文** | SKILL.md 全部 Markdown 内容（含代码示例） | 完整大小（当 L2 不足以解决问题时按需获取） |

- **SKILL.md 格式**：YAML 前置元数据（`name`、`description`）+ Markdown 正文
- **动态工具生成**：每个 SKILL.md 自动生成一个 `skill_xxx` 工具，LLM 按需调用获取指令
- **三层加载优先级**：内置技能（`src/tools/skill/builtin/`）→ 项目本地（`.fyuobot/skills/`）→ 用户全局（`~/.fyuobot/skills/`），同名内置优先
- **可禁用**：SKILL.md 中设置 `disable-model-invocation: true` 可阻止该技能注册为工具

```yaml
# 示例：.fyuobot/skills/run-exe-program/SKILL.md
---
name: run-exe-program
description: Executes a Windows executable file. Use when: the user asks to run, start, open, or execute an .exe program.
---

# 启动 EXE 程序技能

当用户要求启动或打开一个 `.exe` 文件时，你必须接管操作...

## 执行步骤
1. **识别目标**：提取用户提到的文件名
2. **构建命令**：使用 `.\<filename>.exe` 格式
3. **调用工具**：使用 Shell 工具执行该命令
```

### 🔌 MCP 协议支持

- 完整的 MCP (Model Context Protocol) 客户端实现
- 支持 **stdio** 和 **SSE** 两种传输方式
- 远程工具自动发现并注入 Agent 工具链
- 配置文件查找顺序：项目本地 `.fyuobot/mcp.json` → 用户全局 `~/.fyuobot/mcp.json`

### 📊 多厂商中间层

- 自动检测 LLM 提供商（DeepSeek / OpenAI / Anthropic）
- 将各厂商不同格式的 usage 数据归一化为统一结构
- 支持缓存命中/未命中 token 统计显示

### 🗄️ 双层记忆系统

| 层级 | 存储 | 用途 |
|------|------|------|
| 热缓冲区 | `.fyuobot/memories/HISTORY.md` | 每轮对话自动追加，超过 15,000 字符触发归档 |
| 冷归档 | `.fyuobot/history/conversations.db` (SQLite) | 压缩 → 分类 → 汇总 → 精炼后的长期存储，支持全文搜索 |
| 特征提取 | `.fyuobot/memories/USER.md` | 浓缩过程中自动提取用户偏好/习惯，长期记忆持久化 |

**工具调用记录**：每轮对话的工具调用过程（工具名、参数、执行结果）自动追加到 HISTORY.md，方便回溯完整的交互上下文。

### 🎨 终端 UI (React Ink)

- **ASCII Logo 渲染**：启动时渲染 "fyuobot" 艺术字 Logo，使用 3D 轴测线框算法绘制阴影，含当前目录和系统状态信息
- **OSC 8 超链接**：自动将输出中的文件路径和 URL 转换为可点击链接（Ctrl+Click 在编辑器中打开文件，Windows Terminal / VS Code 集成终端均支持）
- **ANSI 颜色自适应**：真彩色（24-bit）→ 256 色 → 16 色自动降级，根据终端能力选择最佳渲染模式
- 自适应 Markdown 渲染（支持代码块、表格、列表等）
- 实时 Token 用量统计（输入/输出/缓存命中/速率）
- 敏感操作确认对话框（Y/N 交互）
- 思维链（thinking）与回答流式分离显示
- **视口自动裁切**：超长输出自动折叠头部，保留最近内容可见
- 历史记录面板（思考过程 / 工具调用 / 工具结果 / 最终回答 / 系统消息）



## 架构设计亮点

### StreamingSession — 框架无关的流式会话层

从 [agentLogic.ts](src/agent/agentLogic.ts) 中提取核心流式逻辑，通过 `StreamHandler` 回调接口将 Agent 的流式交互与 UI 彻底解耦：

```
┌─────────────────────────────────────────────────────┐
│                  StreamingSession                    │
│  • 独立消息上下文  • Token 统计  • 工具调用循环      │
│  • <think> 解析  • 敏感操作确认  • 自动历史记录       │
└──────────────────────┬──────────────────────────────┘
                       │ StreamHandler 回调
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
       TUI         HTTP SSE      WebSocket
    (agentLogic)  (未来扩展)     (未来扩展)
```

### 渐进式技能披露

技能系统采用三级视图的渐进式披露策略，在保证 LLM 获取足够上下文的同时最小化 token 消耗：

```
注册阶段（L1）      调用阶段（L2）               深入阶段（L3）
  ~50 tokens/技能  →  ~500 tokens/次            →  完整内容
  name + desc       执行摘要（标题+列表+要点）    SKILL.md 全文
  ↓                 ↓                          ↓
  tools 列表        skill_xxx 工具返回           L2 不足时按需获取
```

### 启动流程

```
Bootstrap (index.tsx)
  ├─ 0. 初始化 HistoryManager（SQLite + 会话创建）
  ├─ 0.5. 检查外挂工具依赖 → npm install（合并/独立模式）
  ├─ 1. 自动发现本地工具 (src/tools/ + 子目录递归)
  ├─ 1b. 加载外挂工具 (.fyuobot/tools/)
  ├─ 1c. 加载技能工具 (内置 builtin/ → .fyuobot/skills/ → ~/.fyuobot/skills/)
  ├─ 2. 连接 MCP 服务器 → 注入远程工具
  ├─ 3. 注册内置斜杠命令 (src/slash/commands/)
  ├─ 3b. 注册外挂斜杠命令 (.fyuobot/slash/ → ~/.fyuobot/slash/)
  ├─ 4. 创建 AgentRuntime
  ├─ 4.5. 工具生命周期初始化 (onInit)
  ├─ 5. 打印 ASCII Logo (printSystemHeader)
  └─ 6. 挂载 React Ink UI (AgentUI)
```

## fyuobot 工具书架

```
https://github.com/fyuo863/fyuobot_ts_tools
```

## 自定义工具

创建新工具只需三步：

1. 在 `src/tools/` 或其子目录下新建文件，继承 `BaseTool`
2. 实现 `name`、`description`、`parameters` 和 `execute()` 方法
3. 无需修改任何注册代码 — `ToolRegistry` 自动发现（支持子目录递归扫描）

```typescript
import { BaseTool, type ToolParam } from "./basetool.js";

export class MyTool extends BaseTool {
    name = "my_tool";
    description = "我的自定义工具";
    parameters: ToolParam[] = [
        { name: "input", type: "string", description: "输入内容", required: true },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        return `处理结果: ${args.input}`;
    }
}
```

### 工具生命周期钩子

```typescript
export class MyServerTool extends BaseTool {
    // Agent 就绪后调用（可启动伴随服务）
    async onInit(agent: Agent): Promise<void> { /* ... */ }
    // 程序退出前调用（释放资源）
    async onDestroy(): Promise<void> { /* ... */ }
}
```

## 自定义斜杠命令

创建新命令只需三步：

1. 新建文件，实现 `SlashCommand` 接口
2. 设置 `name`、`description`、可选的 `aliases` 和 `execute()` 方法
3. 无需修改任何注册代码 — `CommandRegistry` 自动发现

支持三种加载路径：

| 路径 | 优先级 | 说明 |
|------|--------|------|
| `src/slash/commands/` | 内置 | 随项目分发，扁平 `.ts` 文件 |
| `.fyuobot/slash/` | 外挂（项目本地） | 支持扁平文件或文件夹模式 |
| `~/.fyuobot/slash/` | 外挂（用户全局） | 支持扁平文件或文件夹模式 |

外挂命令与内置命令同名时，内置优先（不覆盖）。

```typescript
// 扁平模式：.fyuobot/slash/hello.ts
import type { SlashCommand, CommandContext } from "../types.js";

export const myCommand: SlashCommand = {
    name: "hello",
    aliases: ["hi"],
    description: "打个招呼",

    execute(ctx: CommandContext) {
        ctx.ui.addSystemMessage("👋 你好！");
        return { type: "success" };
    },
};
```

```
// 文件夹模式：.fyuobot/slash/my-command/index.ts
.fyuobot/
└── slash/
    └── my-command/
        └── index.ts  （导出 SlashCommand 对象）
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js + tsx |
| TUI 框架 | React 19 + Ink 7 |
| LLM SDK | openai 6.x (兼容接口) |
| Markdown | marked + marked-terminal |
| Web 抓取 | Puppeteer + jsdom + @mozilla/readability + turndown |
| MCP | 自研 JSON-RPC 2.0 客户端 |
| 记忆归档 | SQLite (node:sqlite) |
| 终端超链接 | OSC 8 转义序列 |
