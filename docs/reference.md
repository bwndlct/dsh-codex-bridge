# 配置、协议与排错 / Technical Reference

[简体中文首页](<../README.md>) · [English README](<../README.en.md>)

这里保留首页之外的安装细节、协议边界与排错说明。代码行为以当前版本为准；源码更新不代表运行中的 Desktop 已加载新包。

## 安装与发现 / Installation and Discovery

桥接 `0.2.0` 仅支持官方 `deepseek-ai/deepseek-harness` Desktop `0.2.0-rc.2`；早期桥接 `0.1.0` 对应 `0.2.0-rc.1`。已对照官方 App 包中 SessionController 与 Workspace 的运行代码核对创建、目录归属、模型/effort 选择和事件跟踪 API。安装与启用必须经过 Desktop 的 Plugins 页面；不手动修改运行配置、用户配置目录或 Session 文件。

- 第一次安装：通过 HMR 应用，确认 `application: "applied"`，不把重启作为首次安装步骤。
- 替换已安装包、加载已安装源码的新模块：可能返回 `restart-required`，重启由操作者决定。
- 插件默认监听 `127.0.0.1:43127`；端口 `0` 使用临时端口。
- 默认发现路径为 `$DSH_HOME/run/codex-bridge.json`；未配置 `DSH_HOME` 时使用用户目录下的 `.dsh/run/codex-bridge.json`。该文件含鉴权 token，不应分享或提交。
- 发现文件原子写入，权限为 `0600`；实例停止时只删除自己拥有的文件。

构建后的插件目录可直接用于 Plugins 页面。若使用压缩包，把插件包放到仓库外的稳定位置再安装。MCP 压缩包包含完整运行代码，解压后用绝对 Node 路径运行其 `package/lib/bin.js`，不依赖私有 protocol 包的发布。

Codex CLI `0.155.1` 的历史人工验证覆盖了 `dsh_delegate` 与 `dsh_wait` 调用链：在该版本的非交互 `codex exec` 中，默认策略曾报 `MCP tool call requires approval, but approval policy is never`，使用 `default_tools_approval_mode = "approve"` 后通过，而 `"auto"` 未解决该问题。仓库没有 Codex CLI 集成测试或版本锁定，其他版本需单独核对。此配置涉及工具授权，应由操作者选择。

## 委托契约 / Delegation Contract

| 参数 | 规则 |
| --- | --- |
| `task` | 必填，去除首尾空白后非空 |
| `cwd` | 必填，Codex 当前任务的绝对目录；须存在且是目录 |
| `model` | 可选，精确的 `provider/model`，不做猜测或静默替换 |
| `reasoningEffort` | 可选，模型目录中支持的精确 effort ID；可以不传 `model` |

Host 先通过 `realpath` 规范化目录。传入模型或推理程度时，先校验模型目录，再复用或注册 Workspace，最后按 `workspaceId` 创建 Session。目录、Workspace 分组与 Session 的执行位置保持一致，不创建未分组的兜底会话。

两项模型参数都省略时，不调用模型目录或 `selectModel`，直接继承 Host 当前选择。只传推理程度时，使用模型目录中的默认模型；默认模型缺失、不可用或 effort 不支持时明确失败。显式选择调用官方 `selectModel`，它还会后台保存 Host 默认选择。

成功响应包含 `sessionId`、规范化 `cwd`、`workspace.id` 和接纳状态；请求过模型或 effort 时还返回 `model`。`workspace.matched` 只表示查询时是否已有注册；`false` 加上有效 `id` 可以表示新注册的 Workspace，并非失败。`model.source` 是 `default` 或 `override`。

`prompt` 使用队列模式提交一条文本。返回成功只表示接纳，不代表模型完成或任务结果正确。

## 状态与游标 / Status and Cursors

桥接状态为 `queued`、`running`、`idle`、`completed`、`cancelled`、`error`，不是 Host 自身的 Session 枚举。响应保留原始 `running`、`agentAvailable`、`blank`、`updatedAt`。

- 原始 `running` 优先于旧的 `turn/end`；新的 `turn/start` 清除上一轮终态，之后的 `turn/end` 结束新轮次。
- `dsh_follow` 默认返回 100 条事件，最大 500 条；消费后保存 `nextCursor`，检查 `truncated`。
- `dsh_wait` 默认 30 秒，最大 120 秒；超时不取消 Session，断开 HTTP 等待也不取消任务。
- 事件有界、保存在插件进程内；默认每个 Session 保留 512 条，最多配置 4096 条。
- 游标绑定实例、Session 和序号；插件重载后可重新接管已有 Session，但旧游标不能继续使用。
- 默认最多跟踪 100 个 Session，只淘汰非活跃的 LRU 条目，不因容量淘汰正在执行的任务。
- 取消分别报告桥接接纳和 Host 原始 `{ accepted: true }`，保留会话与历史，不回滚文件修改。

## 常见错误 / Troubleshooting

| 错误 | 含义与处理 |
| --- | --- |
| `HOST_NOT_RUNNING` | `DSH Desktop bridge is not running.` 检查 Desktop、插件启用状态及 `DSH_HOME` 是否一致；桥接不会启动 Desktop |
| `INVALID_CWD` | 路径非绝对、不存在或不是目录；修正为确认过的当前任务目录 |
| `MODEL_NOT_FOUND` / `DEFAULT_MODEL_UNAVAILABLE` | 模型路由不匹配或无可用默认模型；检查 Host 目录，不切换到猜测模型 |
| `INVALID_REASONING_EFFORT` | 当前模型不支持该程度；读取错误中的可用值后明确选择 |
| `WORKSPACE_REGISTRATION_FAILED` | 注册分组失败，未继续创建 Session；检查返回原因，不退回其他目录 |
| `SESSION_ADMISSION_FAILED` | Session 已创建，但选择模型或提交 prompt 失败；保留 `details.sessionId` 并检查状态，不自动重复派发 |
| `CURSOR_EXPIRED` | 插件实例已更换；不传旧游标，重新读取事件 |
| `TRACKER_CAPACITY` | 当前跟踪容量内的 Session 都活跃；等待任务结束后再委托 |
| `HOST_TIMEOUT` / `INVALID_HOST_RESPONSE` | 提交结果可能不确定；先核实是否已创建或执行，再考虑重试 |

## 安全与验证 / Security and Verification

HTTP 只接受固定 JSON 路由，所有路由包括健康检查都需要 Bearer token。token 摘要用 `timingSafeEqual` 比较，请求体上限为 1 MiB。MCP 的 stdout 仅用于 JSON-RPC，诊断写 stderr。委托任务仍受 Host 的权限与审批策略约束。

```sh
pnpm check
pnpm pack:plugin
pnpm pack:mcp
```

`check` 包含构建、TypeScript 检查与测试；压缩包冒烟测试覆盖插件 patch、导出、可导入性，以及没有未解析的私有 protocol 依赖。自动验证使用临时目录和临时端口，不安装到或重启 Desktop。

2026-09-30 已在官方 Desktop `0.2.0-rc.2` 上完成桥接 `0.2.0` 实机验收，使用解压后的 MCP 发布包通过 stdio 调用，未绕过 Host 版本检查：

| 项目 | 实测结果 |
| --- | --- |
| Plugins 页面安装与即时加载 | 新版插件启用，鉴权健康检查返回 `0.2.0`，无需重启 Desktop |
| MCP 握手与工具契约 | 握手版本 `0.2.0`，五个工具可见，`cwd` 必填 |
| Workspace 新建与复用 | 首次注册目录，第二次复用同一 Workspace；两个文件任务均写入指定目录 |
| 显式模型与 effort | GLM 5.3 / `max` 完成任务，实际 `request/header` 与请求选择一致 |
| 只传 effort | 继承当时默认的 DeepSeek Flash / `xhigh`，实际请求与返回选择一致；该默认模型不支持的 `max` 被明确拒绝 |
| 等待与增量事件 | 从执行中等待到持久化 `turn/end`；消费游标后不重复返回事件 |
| 超时与取消 | 零时限等待返回超时且任务继续运行；取消被 Host 接纳，原始状态转为非运行，会话与事件仍可查询 |
| 失败边界 | 无鉴权健康检查被拒绝；不存在的目录、不可用模型和不支持的 effort 分别返回明确错误 |

该记录覆盖本次发布的 Workspace 与 effort 行为；第三方插件的功能以及其他 Desktop / Codex CLI 版本不在此验收范围内。

## 源码导航 / Source Map

| 模块 | 入口 |
| --- | --- |
| 严格协议与错误 | [protocol](<../packages/protocol/src/index.ts>) |
| Host 插件与配置 | [插件入口](<../packages/dsh-plugin/src/index.ts>) |
| 工作区、模型与提交 | [BridgeRuntime](<../packages/dsh-plugin/src/runtime.ts>) |
| HTTP 鉴权与发现 | [BridgeHttpServer](<../packages/dsh-plugin/src/server.ts>) |
| 状态、事件与游标 | [EventTracker](<../packages/dsh-plugin/src/tracker.ts>) |
| 五个 MCP 工具 | [MCP 入口](<../packages/mcp-server/src/index.ts>) |

Cordis、Schemastery、session-controller 和 Workspace 服务由 Host 提供，保持 peer 依赖，不打包重复运行时。两个发布包内置私有 protocol 运行代码；protocol 本身无需发布。

## README 设计参考 / README References

版式参考 [ModLens](https://github.com/liustack/modlens) 的语言导航、项目图和独立参考页，以及 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的快速开始与工具表。配图为本项目自行生成，不复用它们的品牌素材或安装命令。
