# Repository Rules

This repository builds a loopback bridge for official `deepseek-ai/deepseek-harness` Desktop 0.2.0-rc.2, plus a stdio MCP server. Bridge 0.2.0 targets this Host; the earlier 0.1.0 release targeted 0.2.0-rc.1. No other Host runtime is supported.

## Runtime constraints

- Install and enable only through Desktop's Plugins page with an absolute built package-directory or external tarball path.
- A first install should activate through HMR with `application: "applied"`; do not make restart part of that path.
- Replacing an installed package or reloading installed-source edits may require a Desktop restart, which the operator owns.
- Do not start, stop, restart, reload, kill, or replace Desktop.
- Do not edit or install into the live profile, `~/.dsh`, persisted Sessions, or `../refs/deepseek-harness`.
- Tests use temporary directories and ephemeral ports. Never commit discovery tokens, credentials, task text, or local profile paths.

## Plugin constraints

- The Host entry is a Cordis function plugin with named `name`, `inject`, `Config`, and `apply` exports and no default export.
- It uses injected `ctx.sessionController` and `ctx.workspaceRegistry` directly.
- Cordis, Schemastery, session-controller, and Workspace remain peer plus development dependencies; do not bundle duplicate Host runtime instances.
- The server binds only `127.0.0.1` and exposes authenticated fixed JSON endpoints.
- No published package may spawn Harness, call a provider directly, edit Session files, or import process-launch APIs.
- Every published package exports `./package.json`; plugin and MCP artifacts must not require publication of the private protocol package.

## Verification

Run `pnpm check`, then `pnpm pack:plugin` and `pnpm pack:mcp`. Packed-artifact smoke tests validate patch metadata, exports, importability, and absence of unresolved private protocol imports. Do not install results into Desktop during automated verification.
