# fyuobot — 终端 AI 编程助手

一个基于 TypeScript 的终端 AI 编程助手（TUI），通过 OpenAI 兼容 API 驱动 LLM，支持工具调用、MCP 协议扩展、双层记忆系统和流式交互。

## 架构概览

| 层级 | 模块 | 说明 |
|------|------|------|
| 🎨 表现层 | **TUI** ([src/tui/](src/tui/)) | React Ink 终端交互界面（Markdown 渲染、Token 统计、确认对话框） |
| 🧠 逻辑层 | **Agent** ([src/agent/](src/agent/)) | Agent 消息构建、工具调用循环、提示词分层、React Hook 驱动 |
| 🌐 通信层 | **LLM** ([src/llm/](src/llm/)) | OpenAI 兼容流式 API 调用、Token 估算 |
| 🔀 中间层 | **Middleware** ([src/middleware/](src/middleware/)) | 多厂商 Usage 归一化（DeepSeek / OpenAI / Anthropic） |
| 🔧 工具层 | **Tools** ([src/tools/](src/tools/)) | 可插拔工具系统（Shell、文件、记忆、压缩、计算器等） |
| 🔌 扩展层 | **MCP** ([src/mcp/](src/mcp/)) | MCP 客户端（JSON-RPC 2.0 / stdio / SSE）→ 远程工具注入 |

## 项目结构

```
src/
├── agent/              # Agent 核心
│   ├── agent.ts        # Agent 类：消息构建 + 工具调用循环
│   ├── agentLogic.ts   # React Hook：驱动 TUI 的完整交互逻辑
│   ├── prompts.ts      # 提示词分层设计（缓存优化）
│   └── runtime.ts      # AgentRuntime：创建与管理 Agent
├── llm/
│   ├── llm.ts          # OpenAI 兼容流式调用 + 工具调用合并
│   └── tokens.ts       # Token 估算
├── mcp/
│   └── mcp.ts          # MCP 客户端（JSON-RPC 2.0 / stdio / SSE）
├── middleware/
│   ├── index.ts        # Provider 注册 + normalizeUsage 入口
│   ├── provider.ts     # detectProvider：自动识别 LLM 厂商
│   ├── types.ts        # 类型定义
│   └── providers/      # DeepSeek / OpenAI / Anthropic 归一化
├── tools/
│   ├── basetool.ts     # BaseTool 抽象类 + ToolRegistry 自动发现
│   ├── shell-tool.ts   # 终端命令执行（标记为敏感操作）
│   ├── file-tool.ts    # 文件读写
│   ├── memory-tool.ts  # 记忆文件读写 + SQLite 历史搜索
│   ├── compress-tool.ts# HISTORY.md → SQLite 归档管道
│   ├── calculator.ts   # 数学计算
│   ├── go-file-fetch.ts# 远程文件获取
│   ├── time-tool.ts    # 时间查询
│   ├── test-tool.ts    # 测试工具
│   └── history-manager.ts # 对话历史管理器（热缓冲 + 冷归档）
└── tui/
    ├── index.tsx        # 启动入口（Bootstrap）
    ├── ui.tsx           # 主交互界面
    ├── colors.tsx       # ANSI 颜色模块
    ├── confirm.tsx      # 敏感操作确认对话框
    └── markdown.tsx     # Markdown 渲染
```

## 核心特性

### 🧠 智能 Agent 系统

- **工具调用循环**：Agent 自动在 LLM 推理和工具执行之间循环，直到任务完成
- **缓存优化的消息排序**：消息按稳定→易变排列（Agent 身份 → USER.md → MEMORY.md → 系统提示词 → 用户查询），最大化 LLM prompt cache 命中率
- **流式响应**：实时逐 token 输出，支持 `<think>` 标签解析（兼容 DeepSeek 等推理模型）
- **敏感操作确认**：标记为 `dangerous` 的工具（如 Shell 命令）执行前需要用户在 TUI 中确认

### 🔧 可扩展工具系统

- **自动发现**：`ToolRegistry.discoverAndRegister()` 扫描目录，自动发现和注册所有 `BaseTool` 子类 — 新增工具只需放一个文件
- **外挂工具**：支持从 `.fyuobot/tools/` 加载用户自定义工具（优先级：项目本地 > 用户全局）
- **流式进度**：工具执行期间支持 `onProgress` 回调，实时汇报进度到 TUI

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
| 热缓冲区 | `.fyuobot/memories/HISTORY.md` | 每轮对话自动追加，超过 20,000 字符触发归档 |
| 冷归档 | `.fyuobot/history/conversations.db` (SQLite) | 压缩 → 分类 → 汇总 → 精炼后的长期存储，支持全文搜索 |

### 🎨 终端 UI (React Ink)

- 自适应 Markdown 渲染（支持代码块、表格、列表等）
- 实时 Token 用量统计（输入/输出/缓存命中/速率）
- 敏感操作确认对话框（Y/N 交互）
- 思维链（thinking）与回答流式分离显示
- 历史记录面板（思考过程 / 工具调用 / 工具结果 / 最终回答）

## 快速上手

### 环境要求

- Node.js ≥ 18
- npm

### 安装与配置

```bash
# 1. 克隆项目
git clone <repo-url>
cd ts-learn

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
| `.env` | API Key、Base URL、模型配置（不提交 git） |
| `.fyuobot/mcp.json` | MCP 服务器配置（可提交 git） |
| `.fyuobot/tools/` | 外挂工具目录 — 项目本地（可提交 git） |
| `.fyuobot/history/` | 对话历史归档（本地，不提交） |
| `.fyuobot/memories/` | 用户记忆 / 偏好（本地，不提交） |
| `~/.fyuobot/tools/` | 外挂工具目录 — 用户全局 |

### MCP 配置示例

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
| 记忆归档 | SQLite |

## 工作流程

1. **启动** → 初始化历史管理器 → 自动发现本地工具 → 加载外挂工具 → 连接 MCP 服务器 → 注入远程工具
2. **用户输入** → 构建缓存优化的消息上下文 → 流式调用 LLM
3. **工具调用** → Agent 解析 tool_calls → 检查敏感操作（需要时弹确认框） → 执行工具 → 将结果反馈 LLM
4. **循环** → 重复 2-3 直到 LLM 不再请求工具调用
5. **记录** → 自动追加对话到 HISTORY.md → 超阈值时触发冷归档管道

## 自定义工具

创建新工具只需三步：

1. 在 `src/tools/` 下新建文件，继承 `BaseTool`
2. 实现 `name`、`description`、`parameters` 和 `execute()` 方法
3. 无需修改任何注册代码 — `ToolRegistry` 自动发现

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
