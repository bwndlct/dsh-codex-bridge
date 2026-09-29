# MCP server

This package provides the `dsh-codex-bridge-mcp` stdio MCP server. It reads the owner-only discovery file written by the Desktop host plugin and exposes `dsh_delegate`, `dsh_status`, `dsh_follow`, `dsh_wait`, and `dsh_cancel`.

It never starts DeepSeek Harness, invokes a model API, or edits persisted sessions.
