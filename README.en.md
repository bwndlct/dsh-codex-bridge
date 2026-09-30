# dsh-codex-bridge

[简体中文](<README.md>) · **English**

[![Desktop](https://img.shields.io/badge/Desktop-0.2.0--rc.2-176B63?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-38823C?style=flat-square)](https://nodejs.org/)
[![MIT](https://img.shields.io/badge/License-MIT-555555?style=flat-square)](<LICENSE>)

**Delegate Codex tasks to your local DeepSeek Harness Desktop.** Reuse the Host's configured model and runtime, then inspect, continue, or cancel the Session in Desktop.

![Codex delegates through stdio MCP and authenticated loopback HTTP; reuse an existing named Workspace or use the ungrouped section](<docs/assets/bridge.en.png>)

- **Automatic grouping without new Workspaces:** reuse an existing DSH Workspace whose title matches the Codex directory name; otherwise use the default ungrouped section at the original directory.
- **Optional model and effort:** inherit the Host model, or specify `model` and `reasoningEffort`.
- **Trackable tasks:** get a Session ID after admission, with status, incremental events, bounded waiting, and cancellation.

> Supports only official Desktop **`0.2.0-rc.2`**. The bridge never starts Desktop, calls a model provider directly, or reads or edits persisted Session files directly.
>
> Upgrading to `0.2.1`? Update both the Desktop plugin and MCP server, and pass absolute `cwd` on every delegation. See the [release notes](<CHANGELOG.md>).

## Quick Start

### 1. Build

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm 11.

```sh
git clone https://github.com/bwndlct/dsh-codex-bridge.git
cd dsh-codex-bridge
pnpm install
pnpm check
pnpm pack:plugin
pnpm pack:mcp
```

The check builds both packages; release tarballs are written to `dist/`.

### 2. Install the Desktop Plugin

In Desktop **Plugins → Add plugin**, enter the absolute built directory, such as `/absolute/path/dsh-codex-bridge/packages/dsh-plugin`, then install and enable it. Alternatively, use an absolute path to a reviewed plugin `.tgz` stored in a stable location outside the repository.

First installation activates through HMR and should return `application: "applied"`, without a restart. Replacing an installed package or loading source updates may require an operator-owned Desktop restart. Do not edit its configuration or Session storage by hand.

### 3. Connect Codex

Add this to your Codex MCP configuration, replacing the absolute paths:

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

`DSH_HOME` must match Desktop; omit it when using the default location. In the manually tested Codex CLI `0.155.1`, non-interactive `codex exec` required `"approve"` to call these tools; check the MCP approval rules for other versions. Remove it in interactive mode to approve each call individually.

## Delegate a Task

Call `dsh_delegate`, **always passing the current Codex task's absolute `cwd`**:

```json
{
  "task": "Run the project tests and summarize the results",
  "cwd": "/absolute/path/to/current-project",
  "model": "your-provider/glm-5.3",
  "reasoningEffort": "max"
}
```

Replace the `your-provider` placeholder with the provider ID configured in Desktop. The model route and effort must match the Host catalog. Omit `model` to inherit the current model; `reasoningEffort` also works on its own. A default-directory environment setting no longer substitutes for `cwd`. Matching titles use DSH display order. The response `cwd` is the Session execution directory. With no match, `workspace.matched` is `false` and `workspace.id` is omitted.

Use the returned `sessionId` with `dsh_wait`, or open the Session in Desktop.

| Tool | Purpose |
| --- | --- |
| `dsh_delegate` | Create a Session and admit the task |
| `dsh_status` | Read mapped bridge status and raw Host state |
| `dsh_follow` | Read incremental events after a cursor |
| `dsh_wait` | Wait up to 120 seconds; timeout never cancels work |
| `dsh_cancel` | Request cancellation of the active turn, retaining history |

## Important Notes

- **Admission is not completion:** verify status and events. Post-creation admission errors include `sessionId`; do not retry blindly.
- **Model selection has a side effect:** the Host's `selectModel` saves its default selection, including reasoning effort, in the background.
- **Local connections only:** HTTP binds to `127.0.0.1`, requires Bearer authentication, and writes discovery with mode `0600`.
- **Cursors are not durable history:** plugin reloads invalidate old cursors. Delegation only reuses existing Workspaces; it never creates or deletes them.

[Configuration, protocol, and troubleshooting (Chinese)](<docs/reference.md>) · [Host plugin](<packages/dsh-plugin/README.md>) · [MCP server](<packages/mcp-server/README.md>) · [Report an issue](https://github.com/bwndlct/dsh-codex-bridge/issues)

## License

[MIT](<LICENSE>) · Copyright (c) 2026 bwndlct.
