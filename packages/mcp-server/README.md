# MCP server

This package provides the `dsh-codex-bridge-mcp` stdio MCP server. It reads the owner-only discovery file written by the Desktop host plugin and exposes `dsh_delegate`, `dsh_status`, `dsh_follow`, `dsh_wait`, and `dsh_cancel`.

It never starts DeepSeek Harness, invokes a model API, or edits persisted sessions.

Always pass the current Codex task's absolute working directory as `cwd` to `dsh_delegate`. Missing or relative `cwd` is rejected; `DSH_DEFAULT_WORKSPACE_CWD` and the MCP process directory are not task-directory fallbacks. A same-title Workspace must be unique and resolve to the task directory; ambiguity or a different path is rejected before Session creation. With no match, the Session uses the default ungrouped section at canonical `cwd`. No Workspace is registered. Unmatched responses omit `workspace.id`.

Update this package together with the Desktop plugin. `dsh_wait` and `dsh_follow` return bounded event results once as JSON in `content[0].text`, without duplicating them in `structuredContent`. Save `nextCursor`; `truncated` indicates a history gap and `bridgeContentTruncated` indicates shortened event content. A transport timeout is an unknown delegation outcome, not permission to resend; reconcile known Session IDs or inspect Desktop before retrying.

`reasoningEffort` can be supplied with or without `model`. Without `model`, it is validated against the Host current default model and applied before prompt admission. Unsupported efforts or an unavailable default produce an error rather than being ignored. The official Host model-selection API also saves the selection as its default in the background.
