# 工具输出配置说明

## 全局配置

在 `.fyuobot/config.json` 中配置工具输出的总开关：

```json
{
  "toolOutput": {
    "enabled": true  // 默认为 true，设置为 false 可全局隐藏所有工具输出
  }
}
```

## 单个工具配置

在工具目录下创建 `config.json` 来配置单个工具的行为：

### 示例 1：隐藏工具输出

```json
{
  "hideOutput": true
}
```

### 示例 2：强制显示输出（忽略全局开关）

```json
{
  "force": true
}
```

### 示例 3：组合配置

```json
{
  "hideOutput": false,
  "force": true  // 即使全局开关关闭，也强制显示此工具的输出
}
```

## 优先级规则

工具输出是否显示的判断逻辑（按优先级）：

1. **force = true**：强制显示输出，忽略其他所有设置
2. **toolOutput.enabled = false**：全局关闭，隐藏所有输出（除非 force = true）
3. **hideOutput**：使用工具自身的 hideOutput 设置

## 使用场景

- **全局关闭输出**：在生产环境或不需要查看详细输出时，设置 `toolOutput.enabled = false`
- **关键工具强制显示**：对于重要的工具（如错误检测、安全扫描），设置 `force = true` 确保输出始终可见
- **噪音工具隐藏**：对于输出信息较多但不太重要的工具，设置 `hideOutput = true`
