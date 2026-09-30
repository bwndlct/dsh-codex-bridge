# dsh-codex-bridge

**简体中文** · [English](<README.en.md>)

[![Desktop](https://img.shields.io/badge/Desktop-0.2.0--rc.2-176B63?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-38823C?style=flat-square)](https://nodejs.org/)
[![MIT](https://img.shields.io/badge/License-MIT-555555?style=flat-square)](<LICENSE>)

让 **Codex 把任务交给本机 DeepSeek Harness Desktop**：复用 Host 已配置的模型和运行时，在 Desktop 中查看、继续或取消会话。

![Codex 通过 MCP 和本机鉴权 HTTP 将任务交给 Desktop；执行目录与 Workspace 分组一致](<docs/assets/bridge.zh-CN.png>)

- **目录与分组一致**：传入 Codex 当前任务目录，复用或注册对应的 DSH Workspace。
- **模型与推理程度可选**：继承 Host 当前模型，或显式指定 `model`、`reasoningEffort`。
- **任务可追踪**：提交后立即返回 Session ID，支持状态、增量事件、等待与取消。

> 仅支持官方 Desktop **`0.2.0-rc.2`**。桥接不启动 Desktop、不直接调用模型服务，也不直接读写持久化 Session 文件。
>
> 从 `0.1.0` 升级时，Desktop 插件与 MCP 服务须一起更新到 `0.2.0`；每次委托都要传绝对 `cwd`。详见[发布说明](<CHANGELOG.md>)。

## 快速开始

### 1. 构建

需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm 11。

```sh
git clone https://github.com/bwndlct/dsh-codex-bridge.git
cd dsh-codex-bridge
pnpm install
pnpm check
pnpm pack:plugin
pnpm pack:mcp
```

检查会构建两个包；发布压缩包输出到 `dist/`。

### 2. 安装 Desktop 插件

在 Desktop **Plugins → Add plugin** 中填写构建后的绝对目录，例如 `/absolute/path/dsh-codex-bridge/packages/dsh-plugin`，安装并启用。也可使用已审阅、放在仓库外稳定位置的插件 `.tgz` 绝对路径。

首次安装通过 HMR 激活，应返回 `application: "applied"`，无需重启。替换已安装包或加载源码更新可能需要由你重启 Desktop；不要手工修改其配置或 Session 存储。

### 3. 连接 Codex

将以下配置加入 Codex 的 MCP 配置，替换为实际绝对路径：

```toml
[mcp_servers.dsh]
command = "/absolute/path/to/node"
args = ["/absolute/path/dsh-codex-bridge/packages/mcp-server/lib/bin.js"]
enabled = true
startup_timeout_sec = 30.0
default_tools_approval_mode = "approve"

[mcp_servers.dsh.env]
DSH_HOME = "/absolute/path/to/the-Desktop-dsh-home"
```

`DSH_HOME` 必须与 Desktop 一致；使用默认位置时可以省略。在已人工验证的 Codex CLI `0.155.1` 中，非交互 `codex exec` 需要上面的 `"approve"` 才能调用这些工具；其他版本请核对其 MCP 审批规则。交互模式下可移除此项以逐次确认。

## 委托一个任务

调用 `dsh_delegate`，**始终传 Codex 当前任务的绝对 `cwd`**：

```json
{
  "task": "运行当前项目的测试并总结结果",
  "cwd": "/absolute/path/to/current-project",
  "model": "your-provider/glm-5.3",
  "reasoningEffort": "max"
}
```

`your-provider` 为占位符，请替换为 Desktop 中实际配置的 provider ID。模型路径和推理程度须匹配 Host 目录；可省略 `model` 以继承当前模型，`reasoningEffort` 也可以单独传。默认目录环境变量不再替代 `cwd`。

拿到 `sessionId` 后，用 `dsh_wait` 等待结果，或在 Desktop 中打开该会话。

| 工具 | 用途 |
| --- | --- |
| `dsh_delegate` | 创建 Session 并提交任务 |
| `dsh_status` | 查询桥接状态与 Host 原始状态 |
| `dsh_follow` | 按游标读取增量事件 |
| `dsh_wait` | 最多等待 120 秒；超时不取消任务 |
| `dsh_cancel` | 请求停止当前轮次，保留会话与历史 |

## 注意事项

- **接纳不等于完成**：以状态和事件确认结果；创建后失败会返回 `sessionId`，不要盲目重试。
- **选择模型有副作用**：Host 的 `selectModel` 会在后台保存默认选择，包括推理程度。
- **仅本机连接**：HTTP 只监听 `127.0.0.1`，需要 Bearer 鉴权；发现文件按 `0600` 写入。
- **游标不是持久化历史**：插件重载后旧游标失效；Workspace 注册失败不会退回“未分组”。

[配置、协议与排错](<docs/reference.md>) · [Host 插件](<packages/dsh-plugin/README.md>) · [MCP 服务](<packages/mcp-server/README.md>) · [反馈问题](https://github.com/bwndlct/dsh-codex-bridge/issues)

## License

[MIT](<LICENSE>) · Copyright (c) 2026 bwndlct.
