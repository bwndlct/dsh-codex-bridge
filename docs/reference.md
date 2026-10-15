# 配置、协议与排错 / Technical Reference

[简体中文首页](<../README.md>) · [English README](<../README.en.md>)

这里保留首页之外的安装细节、协议边界与排错说明。代码行为以当前版本为准；源码更新不代表运行中的 Desktop 已加载新包。

## 安装与发现 / Installation and Discovery

桥接 `0.2.3` 仅支持官方 `deepseek-ai/deepseek-harness` Desktop `0.2.0-rc.2`；早期桥接 `0.1.0` 对应 `0.2.0-rc.1`。已对照官方 App 包中 SessionController 与 Workspace 的运行代码核对创建、目录归属、模型/effort 选择和事件跟踪 API。安装与启用必须经过 Desktop 的 Plugins 页面；不手动修改运行配置、用户配置目录或 Session 文件。

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

Bridge 先通过 `realpath` 规范化目录。传入模型或推理程度时，先校验模型目录，再按规范化目录的最后一段名称匹配已有 Workspace 的 `title`（区分大小写）。同名多项返回 `WORKSPACE_AMBIGUOUS`；唯一匹配项的 `path` 经 `realpath` 后须等于任务目录，否则返回 `WORKSPACE_CWD_MISMATCH`。这些检查都在创建 Session 前完成。匹配时按 `workspaceId` 创建 Session；没有同名项时按规范化 `cwd` 创建 Session，进入默认的未分组分区。整个委派过程不注册新工作区。

两项模型参数都省略时，不调用模型目录或 `selectModel`，直接继承 Host 当前选择。只传推理程度时，使用模型目录中的默认模型；默认模型缺失、不可用或 effort 不支持时明确失败。显式选择调用官方 `selectModel`，并检查其 `{ selected }` 回执与请求的 provider、model 和显式 effort 一致；不一致时不提交 prompt，错误保留已创建的 Session ID。该 API 还会后台保存 Host 默认选择。回执证明选择已安装，不证明模型请求已执行；实际请求配置以安全事件中的 `request/header` 为依据，子 Agent 设置需另有对应证据。

成功响应包含 `sessionId`、执行目录 `cwd`、`workspace.matched` 和接纳状态；请求过模型或 effort 时还返回 `model`。`workspace.matched: true` 表示命中已有同名工作区，并返回其 `id`；`false` 表示默认的未分组分区，不返回 `id`，属于正常成功。`model.source` 是 `default` 或 `override`。

`prompt` 使用队列模式提交一条文本。返回成功只表示接纳，不代表模型完成或任务结果正确。

## 状态与游标 / Status and Cursors

桥接状态为 `queued`、`running`、`idle`、`completed`、`cancelled`、`error`，不是 Host 自身的 Session 枚举。响应保留原始 `running`、`agentAvailable`、`blank`、`updatedAt`。

- 原始 `running` 优先于旧的 `turn/end`；新的 `turn/start` 清除上一轮终态，之后的 `turn/end` 结束新轮次。
- 持久化 `turn/end.reason` 的 `error`、`aborted` 分别恢复为错误、取消状态；接管历史 Session 不依赖已丢失的实时错误通知。
- `dsh_follow` 默认返回 100 条事件，最大 500 条，并受每页 `events` 数组 16 KiB 的序列化预算约束。`dsh_follow` 和 `dsh_wait` 响应都必含 `hasMore`；消费本页后保存 `nextCursor`，`hasMore: true` 时用它继续调用 `dsh_follow`，直到当前积压读完。
- `status.terminal` 只表示执行已结束，与本页之后是否还有事件独立；终态响应仍可能 `hasMore: true`。`status.lastCursor` 是跟踪器已知的最新位置，不能替代已消费页面的 `nextCursor`，否则会跳过未读内容。`truncated` 只表示保留历史已出现缺口，不能用来判断是否还有下一页。
- `dsh_wait` 默认 30 秒，最大 120 秒；超时不取消 Session，断开 HTTP 等待也不取消任务。`hasMore: false` 只表示本次快照没有后续保留事件；任务还在运行时，继续使用已消费的 `nextCursor` 等待或跟踪后续事件。
- 事件有界、保存在插件进程内；默认每个 Session 保留 512 条，最多配置 4096 条。每个分片占一条，较大的消息或较慢的读取都可能使早期分片过期；环形历史缺口和缺失片号都须保留为不完整证据。
- 跟踪不订阅 assistant token stream，并过滤 system/user 消息和请求上下文；`request/header` 只保留模型配置证据。assistant 消息按下述投影传输；序列化后完整事件不超过 4 KiB 时保留投影后的原 `data`，超限时改用可恢复分片，不返回缩短预览。
- 游标绑定实例、Session 和序号；插件重载后可重新接管已有 Session，但旧游标不能继续使用。
- 默认最多跟踪 100 个 Session，创建前预留容量以覆盖并发委托；只淘汰非活跃的 LRU 条目。接管空 Session 不占活跃名额，仍在运行的取消请求不能被淘汰。
- 取消分别报告桥接接纳和 Host 原始 `{ accepted: true }`；该回执只证明已请求取消，停止以 Host 状态或结束事件为准。保留会话与历史，不回滚文件修改。
- 插件释放时结束等待并拒绝重建跟踪；重新加载后用新实例和新游标查询。

MCP `dsh_wait` / `dsh_follow` 只通过 `content[0].text` 返回有界 JSON 页面，不重复写入 `structuredContent`。读取这两个工具 `structuredContent` 的调用方须迁移；其他工具和错误仍保留文本与结构化两通道。HTTP 与 MCP 使用相同的分页、`hasMore` 和分片数据契约。

## 完整事件读取 / Complete Event Consumption

`assistant/message` 的 `data` 只保留 `turn`、`step` 和 `message`。`message` 保留 `id`、`role`、`content`，以及可选的 `source`；`content` 保留全部块及内容，包括 reasoning 块。`data.message.source` 只保留字符串字段 `kind`、`provider`、`model`。`data.stream`、`data.message.source.replayState` 等内部元数据不传输，避免内部回放数据挤占答复内容。该投影只用于 `assistant/message`；`turn/start`、`turn/end`、`assistant/error`、`error` 的 `data` 保留原值，超长时使用同一分片规则。

预算按序列化 JSON 的 UTF-8 字节计算，包含事件外层的 cursor、kind、time 等字段及字符串转义开销。完整事件不超过 4 KiB 时，`data` 保持上述投影后的原值；超限时将该 `data` 序列化为 JSON，再把连续文本拆到多个事件的 `data` 中。每个分片事件仍不超过 4 KiB，每页序列化后的 `events` 数组仍不超过 16 KiB；这些预算不表示整个响应对象只有 16 KiB。

分片的 `data` 使用扁平结构，例如：

```json
{
  "bridgeContentChunk": true,
  "id": "first-chunk-cursor",
  "index": 0,
  "total": 3,
  "encoding": "json",
  "text": "{\"turn\":"
}
```

`id` 等于这组首片的事件 `cursor`，所有片共享此值；每片仍有自己的事件 `cursor`。`index` 从 `0` 开始，`total` 为该组片总数，`text` 是原 JSON 文本的连续片段，单片不必是合法 JSON。调用方按下面顺序读取：

1. 解析 MCP `content[0].text` 的页面 JSON（HTTP 调用方直接读取响应 JSON），按事件 `cursor` 去重。不要按共享的 `id` 或 `durableSeq` 丢弃同组后续分片。
2. 普通事件直接消费 `data`；分片按 `data.id` 跨页面收集，并保留每片的 `index`、`total`、`encoding` 与 `text`。
3. 同组全部 `index = 0..total-1` 齐全且片头一致后，按 index 排序，将 `text` 用 `join('')` 拼接，再执行一次 `JSON.parse`，恢复原事件 `data`。仅收到最后一片、收到若干完整文本块或看到 `turn/end` 都不能代替此检查。
4. 消费本页后保存其 `nextCursor`。`hasMore: true` 时继续 `dsh_follow`，沿页面游标排空当前积压；不要改用 `status.lastCursor`，也不要因 `status.terminal: true` 停止翻页。`hasMore: false` 后若仍在运行，后续可从同一消费游标继续等待或跟踪。
5. 保留历史的 `truncated` 缺口和未齐分片组必须报告为结果不完整；缺片时不解析局部 JSON、不把片尾冒充完整答复，也不自动重新委托任务。即使 `hasMore: false` 或执行已经结束，缺失内容也不会因此恢复。

MCP 仍只有 `dsh_delegate`、`dsh_status`、`dsh_follow`、`dsh_wait`、`dsh_cancel` 五个工具；固定 HTTP 业务路由仍为 `/v1/delegate`、`/v1/status`、`/v1/follow`、`/v1/wait`、`/v1/cancel`。本次修复不新增工具或路由，不改变原请求参数、timeout 或自动重发规则。插件与 MCP 服务必须一起升级到 `0.2.3`，混合版本会被发现协议拒绝。

## 常见错误 / Troubleshooting

| 错误 | 含义与处理 |
| --- | --- |
| `HOST_NOT_RUNNING` | 发现文件缺失；检查 Desktop、插件启用状态及 `DSH_HOME` 是否一致；桥接不会启动 Desktop |
| `HOST_CONNECTION_UNREADABLE` / `INVALID_DISCOVERY_FILE` | 发现文件不可读取或格式无效；保留原错误，检查文件与访问权限，不当作 Desktop 未运行 |
| `HOST_VERSION_MISMATCH` | 发现的桥接版本不匹配；由操作者一起更新插件与 MCP 服务 |
| `INVALID_CWD` | 路径非绝对、不存在或不是目录；修正为确认过的当前任务目录 |
| `WORKSPACE_AMBIGUOUS` / `WORKSPACE_CWD_MISMATCH` | 同名工作区多项或目录不等于任务目录；创建前拒绝，由操作者核对工作区配置 |
| `MODEL_NOT_FOUND` / `DEFAULT_MODEL_UNAVAILABLE` | 模型路由不匹配或无可用默认模型；检查 Host 目录，不切换到猜测模型 |
| `INVALID_REASONING_EFFORT` | 当前模型不支持该程度；读取错误中的可用值后明确选择 |
| `SESSION_ADMISSION_FAILED` | Session 已创建，但选择模型或提交 prompt 失败；保留 `details.sessionId` 并检查状态，不自动重复派发 |
| `CURSOR_EXPIRED` | 插件实例已更换；不传旧游标，重新读取事件 |
| `TRACKER_CAPACITY` | 当前跟踪容量内的 Session 都活跃；等待任务结束后再委托 |
| `HOST_TIMEOUT` / `INVALID_HOST_RESPONSE` | 提交结果可能不确定；先核实是否已创建或执行，再考虑重试 |

传输超时或断连不自动重试。现有五个工具只能按已知 `sessionId` 查询；响应丢失且 ID 未知时，在官方 Desktop 中按提交时间、目录和任务文本只读核对，再决定后续操作。没有新增查询任务 ID 或幂等重发工具。

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

以上为 `0.2.0` 的历史实机验收，Workspace 注册行为已经在 `0.2.1` 移除。`0.2.2` 的目录校验、模型回执、生命周期和事件预算修复使用自动测试验证；本仓库未记录该版本的完整 Desktop 实机验收。`0.2.3` 新增的事件投影、分片恢复和分页契约须通过构建、回归测试及发布包冒烟检查；这些离线检查与源码、日志分析都不能证明实机验收。本次未将 `0.2.3` 安装到真实 Desktop，未重启 Desktop；安装后的实机检查仍需操作者执行。第三方插件功能及其他 Desktop / Codex CLI 版本不在此范围内。

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
