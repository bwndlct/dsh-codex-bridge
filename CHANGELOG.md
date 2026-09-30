# Changelog

## 0.2.0 - 2026-09-30

### Breaking Changes

- The supported Host moves from official Desktop `0.2.0-rc.1` to `0.2.0-rc.2`; Host peer versions remain exact, with no compatibility override.

- `dsh_delegate` now requires the current Codex task's absolute `cwd`. The MCP process directory and `DSH_DEFAULT_WORKSPACE_CWD` no longer substitute for it.
- Delegation reuses or registers the corresponding Desktop Workspace and creates the Session through its `workspaceId`. Registration failure does not fall back to an ungrouped Session.
- Upgrade the Desktop plugin and MCP server together. Bridge discovery now requires version `0.2.0`; mixed `0.1.0` and `0.2.0` installations are rejected.

### Added

- Optional `reasoningEffort`, validated against the Host model catalog before Workspace or Session creation.
- Effort-only requests use the Host current default model; explicit model overrides remain supported.
- Chinese-first and English READMEs, localized architecture diagrams, and a technical reference.
- Version consistency checks for packed artifacts and the MCP handshake.

### Compatibility

- Official DeepSeek Harness Desktop `0.2.0-rc.2` only. Version `0.1.0` targeted the older `0.2.0-rc.1` Host.
- Explicit model or effort selection uses the official `selectModel` API, which may save the Host default selection in the background.
- Codex approval guidance is scoped to the manually tested CLI `0.155.1`; other versions require their own approval-policy checks.

### Verification

- Build, TypeScript checks, and all 33 tests pass, including packed-artifact smoke tests.
- Desktop `0.2.0-rc.2` live acceptance through the packed stdio MCP server covers Workspace creation/reuse, GLM 5.3/max, effort-only default selection, event cursors, bounded waiting, and cancellation with retained history. See [the technical reference](docs/reference.md).

## 0.1.0 - 2026-09-29

Initial loopback Desktop plugin and stdio MCP server, with delegation, status, incremental events, bounded waiting, and cancellation.
