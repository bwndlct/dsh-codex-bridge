# Changelog

## 0.2.3 - 2026-10-15

- Fix final-answer loss when large internal stream or replay metadata accompanied an assistant message. Project assistant events to turn/step, message ID/role and every content block (including reasoning), with source limited to kind/provider/model; omit internal stream and replay metadata.
- Replace oversized event previews with reversible chunks. Events whose complete serialized envelope fits within 4 KiB retain their projected data; larger data is serialized as JSON and split into consecutive `text` fragments in flat `data: { bridgeContentChunk: true, id, index, total, encoding: "json", text }` envelopes. `id` is the first chunk's cursor, and `index` starts at zero. Each serialized event stays within 4 KiB and each serialized page's `events` array within 16 KiB.
- Add required `hasMore` to follow/wait responses. Continue from each page's `nextCursor` while it is true, even when `status.terminal` is true. Do not substitute `status.lastCursor` for the consumed cursor. Deduplicate by event cursor, collect every chunk index from `0` through `total - 1` by chunk ID, then `join('')` and `JSON.parse` to recover the projected data; a final chunk alone is incomplete.
- Retain the in-memory ring defaults (512 entries, configurable up to 4096). Each chunk consumes one entry and can expire; `truncated` still means a retained-history gap, and missing chunk indexes must be reported as incomplete data.
- Keep the five MCP tools, fixed HTTP routes, request parameters, timeout behavior, and no automatic redispatch. `dsh_wait` / `dsh_follow` still return JSON only in `content[0].text`.
- Update the Desktop plugin and MCP server together; discovery requires `0.2.3`. Host support remains official Desktop `0.2.0-rc.2`. No live Desktop installation or acceptance was performed for this release; source/log analysis and offline checks do not establish live acceptance.

## 0.2.2 - 2026-10-08

- Reject ambiguous Workspace titles and canonical directory mismatches before creating a Session; retain ungrouped admission when no title matches.
- Check the official `selectModel` receipt against the requested route and explicit effort before prompt admission; preserve the Session ID on post-creation failure.
- Reserve tracking capacity for concurrent admissions, restore error/aborted endings from durable events, retain running cancellation requests, and settle waits during disposal.
- Filter private conversation context and token streams from events. Keep safe model configuration evidence, bound event pages to 16 KiB, and mark oversized event previews with `bridgeContentTruncated`; cursor `truncated` continues to mean a retained-history gap.
- Distinguish missing, unreadable, invalid, and incompatible discovery files. Unknown submission outcomes are not retried automatically; reconcile them in Desktop when the Session ID is unavailable.
- MCP compatibility: `dsh_wait` and `dsh_follow` now return their bounded JSON only in `content[0].text`, without duplicate `structuredContent`. Callers using those tools' `structuredContent` must migrate. Other tool/error channels and HTTP response data are unchanged.
- Update the Desktop plugin and MCP server together; discovery requires `0.2.2`. Host support remains official Desktop `0.2.0-rc.2`. No live Desktop installation or acceptance was performed for this release.

## 0.2.1 - 2026-09-30

- Match the canonical Codex directory name to an existing DSH Workspace title, in display order.
- With no matching title, create an ungrouped Session at the supplied directory in the default section; never register a Workspace.
- The response `cwd` reports the Session execution directory. Unmatched responses set `workspace.matched: false` and omit `workspace.id`.
- Update the Desktop plugin and MCP server together; discovery now requires `0.2.1`. Host support remains official Desktop `0.2.0-rc.2`.

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
