# dsh-codex-bridge

`dsh-codex-bridge` lets Codex delegate work to the model and Session runtime already configured in official DeepSeek Harness Desktop. A Desktop Host plugin serves authenticated loopback JSON; a separate stdio MCP process exposes five tools.

Supported Host: official `deepseek-ai/deepseek-harness` Desktop `0.2.0-rc.1` at commit `4878cda`, only.

## Architecture

```text
Codex -> stdio MCP -> bearer-auth HTTP on 127.0.0.1 -> Desktop Host plugin
                                                             |
                                                             +-> ctx.sessionController
                                                             +-> ctx.workspaceRegistry
```

- `packages/protocol` owns strict wire schemas, statuses, cursors, and errors.
- `packages/dsh-plugin` is a named-export Cordis function plugin for the official Desktop Host.
- `packages/mcp-server` provides `dsh_delegate`, `dsh_status`, `dsh_follow`, `dsh_wait`, and `dsh_cancel`.

Nothing starts Harness, calls a provider directly, or reads or edits persisted session data.

## Desktop API chain

1. MCP requires the current Codex task's absolute `cwd`; it never substitutes its process directory or a fixed default Workspace.
2. The Host canonicalizes `cwd` and requires an existing directory.
3. The Host resolves the Workspace by canonical path, then uses `workspaceRegistry.create(cwd)` when none exists. This official API reuses concurrent registrations for the same path and gives new Workspaces the directory name. Session creation always uses `workspaceId`, so its actual directory and Desktop grouping agree. Registration failure aborts delegation; there is no ungrouped fallback.
4. Omitting both `model` and `reasoningEffort` makes no catalog or selection call; Desktop inherits its current selection directly. With either parameter, `sessionController.modelCatalog()` validates the model and effort before any Workspace or Session is created. Effort alone uses the catalog's current default model; a missing default or unsupported effort fails explicitly.
5. After creation, a requested model or effort calls `selectModel`; then `prompt` admits one queued text item with a random request id. The official `selectModel` API also saves the selection as the Host default in the background.
6. Delegation returns `sessionId`, status, canonical `cwd`, the Workspace id, and the accepted model selection when one was requested. `workspace.matched` means a registration existed at lookup time; it can be false while `workspace.id` identifies the newly registered Workspace. Effort alone reports model `source: "default"`.
7. If selection or prompt fails after creation, structured error details contain `sessionId`. The visible Desktop Session is retained for recovery.
8. Cancellation reports bridge acceptance separately from raw DSH `{ accepted: true }`. It does not claim a DSH cancelled enum and never deletes history.

Mapped statuses are bridge-owned. Raw `running` has priority over an old `turn/end`; a later `turn/start` clears prior terminal state, and its next `turn/end` completes. Responses preserve raw DSH `running`, `agentAvailable`, `blank`, and `updatedAt`.

After plugin reload, status/follow/wait can lazily adopt a valid existing Session through `list` and `follow`. The new cursor generation starts fresh, so old cursors still fail with `CURSOR_EXPIRED`.

## Build and pack

Requires Node `^22.19.0 || >=24.0.0` and pnpm 11.

```sh
pnpm install
pnpm check
pnpm pack:plugin
pnpm pack:mcp
```

Tarballs go to ignored `dist/`. Plugin and MCP JavaScript bundle the private protocol runtime while retaining strict declarations. The plugin keeps Desktop-owned Cordis, Schemastery, session-controller, and Workspace services as peers, avoiding duplicate Host runtime instances.

## Install in Desktop

Use the official Desktop Plugins page:

1. Build and review the plugin package.
2. Open **Plugins** in Desktop `0.2.0-rc.1`, then choose **Add plugin**.
3. Enter either the absolute built package directory, such as `/absolute/path/dsh-codex-bridge/packages/dsh-plugin`, or an absolute path to the reviewed `.tgz` copied to a stable location outside this repository.
4. Let Desktop inspect, install, select, and apply the bundle.
5. For a first installation with Desktop HMR available, require `application: "applied"`. No restart is part of the MVP first-install path.

Do not mutate Desktop's reserved profile manually. Automated checks do not install into the live application.

### Official source evidence

Official Desktop `app.asar` includes these `0.2.0-rc.1` files:

- `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` defines `- insert:` bundle rows and says a new bundle can activate through HMR.
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js` identifies the Plugins page, accepts an absolute local directory, and recognizes tarballs.
- `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js` reports `application: "applied"` with HMR and returns `restart-required` when an installed package is replaced.
- `dsh/node_modules/@deepseek-ai/schemastery/package.json` is version `3.18.4`.

Current limitation: replacing an installed package, or expecting edits under an already installed source to load a fresh JavaScript module generation, can require a Desktop restart. This is separate from first installation.

The plugin binds only `127.0.0.1`, port `43127` by default. Discovery is written atomically with mode `0600` and removed only while owned by that instance.

## Configure Codex

Unpack the self-contained MCP tarball in a stable location, then point Codex at it:

```toml
[mcp_servers.dsh]
command = "/absolute/path/to/node"
args = ["/stable/path/@dsh-codex-bridge/mcp-server/lib/bin.js"]
enabled = true
startup_timeout_sec = 30.0
default_tools_approval_mode = "approve"

[mcp_servers.dsh.env]
DSH_HOME = "/absolute/path/to/the-Desktop-dsh-home"
```

`dsh_delegate` now requires `cwd` on every call. Codex must pass its current task's absolute project directory, including when using a different project or worktree. Existing callers that omit `cwd` must be updated; `DSH_DEFAULT_WORKSPACE_CWD` no longer redirects delegation.

For example, delegate with `{ "task": "Run the project tests", "cwd": "/absolute/path/to/current-project", "reasoningEffort": "max" }`. This reuses or registers that directory's Desktop Workspace and applies `max` to the Host current default model if supported.

Pin an absolute `node`; do not rely on `PATH` resolution. `default_tools_approval_mode = "approve"` is required for non-interactive runs: under the default policy `codex exec` fails with `MCP tool call requires approval, but approval policy is never`, and `"auto"` is not sufficient for these tools. In interactive Codex, keep `"approve"` for silent delegation or drop the key to be prompted on every call.

Verified against Codex CLI `0.155.1`: `codex exec` called `dsh_delegate` then `dsh_wait` and received a completed ordinary Session whose delegated work landed as expected.

The MCP process reserves stdout for JSON-RPC and diagnostics for stderr. Missing discovery or an unreachable Host produces code `HOST_NOT_RUNNING` with exact message `DSH Desktop bridge is not running.` It never starts Desktop. `dsh_wait` is capped at 120 seconds; timeout never cancels work.

## Security

The server accepts fixed routes only on `127.0.0.1`, requires bearer auth even for health, compares token digests with `timingSafeEqual`, and caps bodies at 1 MiB. Each request owns an abort controller; disconnecting a long wait removes its listener without cancelling the Desktop Session.

Active/running Sessions are never evicted for capacity; only inactive LRU entries are eligible. Opaque cursors bind plugin instance, Session identity, and ordinal, rejecting stale, cross-Session, and future cursors.

## Manual Cases A-E

These are operator-run acceptance cases. Automated work does not install into or restart Desktop.

| Case | Procedure | Expected | Result |
| --- | --- | --- | --- |
| A: `test.txt` | Delegate in a temporary directory to create `test.txt` containing a known line; wait and inspect the file and visible Desktop Session. | Session id returns after admission; file is correct; status completes; returned cwd/Workspace details match Desktop and no model override occurs. | Passed locally: `session-1eceed70-73d6-41c5-8dfd-f8b93c08ab60`, durable `turn/end` seq 29, exact bytes `hello from dsh\n` |
| B: long task | Delegate a task long enough for multiple follow and bounded wait calls. | Cursors advance without duplication; wait timeout does not cancel; eventual delegated `turn/end` completes. | Incremental follow exercised with 328 events; bounded timeout remains covered automatically, not repeated manually |
| C: cancel | Delegate a long active turn, call `dsh_cancel`, then inspect Desktop. | Bridge and raw DSH acceptance are distinct; active turn stops; Session and history remain. | Passed locally: Running observed, both acceptances true, `agentAvailable` remained true, `cancel.txt` absent, Desktop stayed online |
| D: Desktop continuation | After delegated completion, continue the same Session from Desktop and submit another prompt. | Raw running/new `turn/start` clears old terminal state; the next `turn/end` completes the new turn. | Passed through Desktop's official `session/prompt` Remote: same Session completed a second turn at seq 37 with retained history |
| E: Host absent | Invoke a tool with discovery absent or the plugin unavailable, without stopping the user's live Desktop. | Text and `structuredContent` contain `HOST_NOT_RUNNING` and exact message; stdout remains MCP protocol only. | Passed in automated isolated-discovery test; live Desktop was intentionally not stopped |

## Limitations

- Events and cursors are bounded process-local observations, not durable transcript storage.
- Adoption rebuilds live observation only; old plugin cursors cannot resume.
- Status values are bridge projections, not invented DSH Session enums.
- Package replacement and installed-source edits may need a Desktop restart for a fresh module generation.
- There is no remote transport, mobile client, attachment upload, or approval UI.

## License

MIT. Copyright (c) 2026 bwndlct.
