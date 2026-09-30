# MCP server

This package provides the `dsh-codex-bridge-mcp` stdio MCP server. It reads the owner-only discovery file written by the Desktop host plugin and exposes `dsh_delegate`, `dsh_status`, `dsh_follow`, `dsh_wait`, and `dsh_cancel`.

It never starts DeepSeek Harness, invokes a model API, or edits persisted sessions.

Always pass the current Codex task's absolute working directory as `cwd` to `dsh_delegate`. Missing or relative `cwd` is rejected; `DSH_DEFAULT_WORKSPACE_CWD` is no longer used, and the MCP process directory is not a task-directory fallback. The Host reuses or registers the corresponding Desktop Workspace and creates the Session in that group.

`reasoningEffort` can be supplied with or without `model`. Without `model`, it is validated against the Host current default model and applied before prompt admission. Unsupported efforts or an unavailable default produce an error rather than being ignored. The official Host model-selection API also saves the selection as its default in the background.
