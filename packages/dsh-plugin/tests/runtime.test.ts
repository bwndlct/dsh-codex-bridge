import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError } from '@dsh-codex-bridge/protocol'
import type { FollowFrame, BridgeContext, SessionControllerLike } from '../src/types.js'
import { BridgeRuntime } from '../src/runtime.js'

class FrameStream {
  private frames: FollowFrame[] = []
  private wake?: () => void

  emit(frame: FollowFrame): void {
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  async *iterate(signal: AbortSignal): AsyncIterable<FollowFrame> {
    yield { type: 'snapshot', cursor: -1, records: [] }
    while (!signal.aborted) {
      const frame = this.frames.shift()
      if (frame !== undefined) yield frame
      else await new Promise<void>(resolve => {
        this.wake = resolve
        signal.addEventListener('abort', resolve, { once: true })
      })
    }
  }
}

function harness(workspaces: { id: string; path: string; title: string }[] = [], failPrompt = false, maxSessions = 10) {
  const stream = new FrameStream()
  let running = false
  const calls: { create: unknown[]; workspaceCreate: string[]; prompt: unknown[]; select: unknown[]; cancel: unknown[]; order: string[] } = {
    create: [], workspaceCreate: [], prompt: [], select: [], cancel: [], order: [],
  }
  const controller: SessionControllerLike = {
    async create(request) { calls.order.push('create'); calls.create.push(request); return { sessionId: 'session-1' } },
    async modelCatalog() { calls.order.push('modelCatalog'); return { default: { provider: 'provider', model: 'model/v2' }, groups: [{ id: 'provider', models: [{ id: 'model/v2', reasoning: { efforts: [{ id: 'max' }] } }] }] } },
    async selectModel(request) {
      calls.order.push('selectModel')
      calls.select.push(request)
      return { selected: { provider: request.provider, model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }
    },
    async prompt(request) {
      calls.order.push('prompt')
      calls.prompt.push(request)
      if (failPrompt) throw new Error('prompt refused')
      return { accepted: true }
    },
    async list() {
      return { items: [{ sessionId: 'session-1', running, agentAvailable: true, blank: false, updatedAt: 1 }] }
    },
    follow(_request, signal) { return stream.iterate(signal) },
    cancel(request) { calls.cancel.push(request); return { accepted: true } },
  }
  const registry = {
    list() {
      calls.order.push('listWorkspaces')
      return workspaces
    },
    async create(path: string) {
      calls.workspaceCreate.push(path)
      throw new Error('Workspace creation is forbidden')
    },
  }
  const context = { sessionController: controller, workspaceRegistry: registry } as BridgeContext
  return { runtime: new BridgeRuntime(context, crypto.randomUUID(), 32, maxSessions), stream, calls, controller, registry, setRunning(value: boolean) { running = value } }
}

const runtimes: BridgeRuntime[] = []
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose() })

describe('BridgeRuntime delegation', () => {
  it('resolves a registered workspace, inherits the Host model, and admits the exact prompt', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness([{ id: 'workspace-1', path: cwd, title: basename(cwd) }])
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: '  do work  ', cwd }, AbortSignal.timeout(1_000))
    expect(result.sessionId).toBe('session-1')
    expect(h.calls.create).toEqual([{ workspaceId: 'workspace-1' }])
    expect(h.calls.select).toEqual([])
    expect(h.calls.order).toEqual(['listWorkspaces', 'create', 'prompt'])
    expect(result).toMatchObject({
      cwd,
      workspace: { matched: true, id: 'workspace-1' },
    })
    expect(result.model).toBeUndefined()
    expect(h.calls.prompt).toHaveLength(1)
    expect(h.calls.prompt[0]).toMatchObject({ sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'do work' }] })
    expect((h.calls.prompt[0] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('uses the default ungrouped section at canonical cwd without registering a Workspace', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness()
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2' }, AbortSignal.timeout(1_000))
    expect(h.calls.workspaceCreate).toEqual([])
    expect(h.calls.create).toEqual([{ cwd }])
    expect(result).toMatchObject({ cwd, workspace: { matched: false } })
    expect(result.workspace.id).toBeUndefined()
    expect(h.calls.select).toEqual([{ sessionId: 'session-1', provider: 'provider', model: 'model/v2' }])
    expect(h.calls.order).toEqual(['modelCatalog', 'listWorkspaces', 'create', 'selectModel', 'prompt'])
  })

  it('selects max before prompting and rejects unavailable efforts before creating a Session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2', reasoningEffort: 'max' }, AbortSignal.timeout(1_000))
    expect(h.calls.select).toEqual([{ sessionId: 'session-1', provider: 'provider', model: 'model/v2', reasoningEffort: 'max' }])
    expect(result.model).toMatchObject({ provider: 'provider', model: 'model/v2', reasoningEffort: 'max', source: 'override' })
    await expect(h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2', reasoningEffort: 'low' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'INVALID_REASONING_EFFORT' })
    expect(h.calls.create).toHaveLength(1)
  })

  it('applies reasoning effort to the Host default without an explicit model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness([{ id: 'workspace-1', path: cwd, title: basename(cwd) }])
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: 'work', cwd, reasoningEffort: 'max' }, AbortSignal.timeout(1_000))
    expect(h.calls.select).toEqual([{ sessionId: 'session-1', provider: 'provider', model: 'model/v2', reasoningEffort: 'max' }])
    expect(result.model).toEqual({ provider: 'provider', model: 'model/v2', reasoningEffort: 'max', source: 'default' })
    expect(h.calls.order).toEqual(['modelCatalog', 'listWorkspaces', 'create', 'selectModel', 'prompt'])
    expect(h.calls.workspaceCreate).toEqual([])
  })

  it('rejects an unavailable inherited effort before creating a Session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd, reasoningEffort: 'low' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'INVALID_REASONING_EFFORT' })
    expect(h.calls.workspaceCreate).toEqual([])
    expect(h.calls.create).toEqual([])
  })

  it('rejects missing or unavailable Host defaults without choosing another model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.controller, 'modelCatalog').mockResolvedValueOnce({ groups: [] })
      .mockResolvedValueOnce({ default: { provider: 'missing', model: 'model' }, groups: [] })
    await expect(h.runtime.delegate({ task: 'work', cwd, reasoningEffort: 'max' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'DEFAULT_MODEL_UNAVAILABLE' })
    await expect(h.runtime.delegate({ task: 'work', cwd, reasoningEffort: 'max' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    expect(h.calls.workspaceCreate).toEqual([])
    expect(h.calls.create).toEqual([])
  })

  it('reuses the registered Workspace for symlink aliases of the same directory', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const alias = join(await mkdtemp(join(tmpdir(), 'bridge-alias-')), 'project')
    await symlink(cwd, alias, 'dir')
    const h = harness([{ id: 'workspace-1', path: cwd, title: basename(cwd) }])
    runtimes.push(h.runtime)
    await h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    const result = await h.runtime.delegate({ task: 'work', cwd: alias }, AbortSignal.timeout(1_000))
    expect(h.calls.workspaceCreate).toEqual([])
    expect(h.calls.create).toEqual([{ workspaceId: 'workspace-1' }, { workspaceId: 'workspace-1' }])
    expect(result).toMatchObject({ cwd, workspace: { matched: true, id: 'workspace-1' } })
  })

  it('rejects a same-title Workspace at another directory before creating a Session', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const workspacePath = await realpath(await mkdtemp(join(tmpdir(), 'bridge-workspace-')))
    const h = harness([{ id: 'workspace-1', path: workspacePath, title: basename(cwd) }])
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'WORKSPACE_CWD_MISMATCH', details: { expected: cwd, observed: workspacePath, workspaceId: 'workspace-1' },
    })
    expect(h.calls.create).toEqual([])
    expect(h.calls.prompt).toEqual([])
    expect(h.calls.workspaceCreate).toEqual([])
  })

  it('rejects ambiguous same-title Workspaces without creating or prompting', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness([
      { id: 'workspace-1', path: cwd, title: basename(cwd) },
      { id: 'workspace-2', path: cwd, title: basename(cwd) },
    ])
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'WORKSPACE_AMBIGUOUS' })
    expect(h.calls.create).toEqual([])
    expect(h.calls.prompt).toEqual([])
  })

  it('accepts an equivalent Workspace symlink and returns canonical cwd', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const alias = join(await mkdtemp(join(tmpdir(), 'bridge-workspace-alias-')), 'project')
    await symlink(cwd, alias, 'dir')
    const h = harness([{ id: 'workspace-1', path: alias, title: basename(cwd) }])
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
      cwd, workspace: { matched: true, id: 'workspace-1' },
    })
  })

  it('does not group by path when the Workspace has a different title', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness([{ id: 'workspace-1', path: cwd, title: 'renamed-workspace' }])
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    expect(h.calls.create).toEqual([{ cwd }])
    expect(result.workspace).toEqual({ matched: false })
    expect(h.calls.workspaceCreate).toEqual([])
  })

  it('does not hide Workspace lookup failures by creating an ungrouped Session', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.registry, 'list').mockImplementation(() => { throw new Error('storage refused') })
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toThrow('storage refused')
    expect(h.calls.create).toEqual([])
    expect(h.calls.prompt).toEqual([])
  })

  it('rejects files and unavailable model overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    const h = harness()
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd: '.' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'INVALID_CWD' })
    await expect(h.runtime.delegate({ task: 'work', cwd: file }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'INVALID_CWD' })
    await expect(h.runtime.delegate({ task: 'work', cwd: root, model: 'provider/missing' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    expect(h.calls.create).toEqual([])
  })

  it('returns the created session id when post-create admission fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness([], true)
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED',
      details: { sessionId: 'session-1', cause: 'prompt refused' },
    })
    expect(h.calls.create).toHaveLength(1)
  })

  it('returns the created session id even when tracker admission fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.runtime.tracker, 'start').mockImplementationOnce(() => {
      throw new BridgeError('TRACKER_CAPACITY', 'tracking refused', 503)
    })
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED', details: { sessionId: 'session-1', code: 'TRACKER_CAPACITY' },
    })
    expect(h.calls.prompt).toEqual([])
  })

  it('reserves capacity before asynchronous creation so concurrent requests cannot leave an orphan', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness([], false, 1)
    runtimes.push(h.runtime)
    let complete!: (result: { sessionId: string }) => void
    const created = new Promise<{ sessionId: string }>(resolve => { complete = resolve })
    const create = vi.spyOn(h.controller, 'create').mockReturnValueOnce(created)
    const first = h.runtime.delegate({ task: 'first', cwd }, AbortSignal.timeout(1_000))
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await expect(h.runtime.delegate({ task: 'second', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'TRACKER_CAPACITY' })
    expect(create).toHaveBeenCalledOnce()
    complete({ sessionId: 'session-1' })
    await expect(first).resolves.toMatchObject({ sessionId: 'session-1' })
    expect(h.calls.prompt).toHaveLength(1)
  })

  it('releases reserved capacity when Host creation fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness([], false, 1)
    runtimes.push(h.runtime)
    vi.spyOn(h.controller, 'create').mockRejectedValueOnce(new Error('create refused'))
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toThrow('create refused')
    await expect(h.runtime.delegate({ task: 'retry after definite rejection', cwd }, AbortSignal.timeout(1_000))).resolves.toMatchObject({ sessionId: 'session-1' })
  })

  it('protects a newly admitted Session that status adopted before create returned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness([], false, 2)
    runtimes.push(h.runtime)
    let complete!: (result: { sessionId: string }) => void
    const created = new Promise<{ sessionId: string }>(resolve => { complete = resolve })
    const create = vi.spyOn(h.controller, 'create').mockReturnValueOnce(created)
    const pending = h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect((await h.runtime.status('session-1', AbortSignal.timeout(100))).status).toBe('idle')
    complete({ sessionId: 'session-1' })
    await expect(pending).resolves.toMatchObject({ sessionId: 'session-1' })
    h.runtime.tracker.start('session-2')
    expect(() => h.runtime.tracker.reserveCapacity()).toThrowError(expect.objectContaining({ code: 'TRACKER_CAPACITY' }))
  })

  it('does not create a Session for an already-aborted request', async () => {
    const h = harness()
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd: tmpdir() }, AbortSignal.abort(new Error('request cancelled')))).rejects.toThrow('request cancelled')
    expect(h.calls.create).toEqual([])
    expect(h.calls.prompt).toEqual([])
  })

  it('retains the Session id and does not prompt if the client aborts during creation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    const abort = new AbortController()
    let complete!: (result: { sessionId: string }) => void
    const created = new Promise<{ sessionId: string }>(resolve => { complete = resolve })
    const create = vi.spyOn(h.controller, 'create').mockReturnValueOnce(created)
    const pending = h.runtime.delegate({ task: 'work', cwd }, abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED', details: { sessionId: 'session-1', cause: 'client disconnected' },
    })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    abort.abort(new Error('client disconnected'))
    complete({ sessionId: 'session-1' })
    await rejected
    expect(h.calls.prompt).toEqual([])
  })

  it('retains the Session id if the bridge stops during creation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    let complete!: (result: { sessionId: string }) => void
    const created = new Promise<{ sessionId: string }>(resolve => { complete = resolve })
    const create = vi.spyOn(h.controller, 'create').mockReturnValueOnce(created)
    const pending = h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED', details: { sessionId: 'session-1', code: 'BRIDGE_STOPPED' },
    })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    h.runtime.dispose()
    complete({ sessionId: 'session-1' })
    await rejected
    expect(h.calls.prompt).toEqual([])
  })

  it('reports the normalized Host selection including its default effort', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.controller, 'selectModel').mockResolvedValueOnce({ selected: { provider: 'provider', model: 'model/v2', reasoningEffort: 'max' } })
    await expect(h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2' }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
      model: { provider: 'provider', model: 'model/v2', reasoningEffort: 'max', source: 'override' },
    })
  })

  it('does not prompt after the bridge stops during model selection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    let complete!: (result: Awaited<ReturnType<SessionControllerLike['selectModel']>>) => void
    const selected = new Promise<Awaited<ReturnType<SessionControllerLike['selectModel']>>>(resolve => { complete = resolve })
    const select = vi.spyOn(h.controller, 'selectModel').mockReturnValueOnce(selected)
    const pending = h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2' }, AbortSignal.timeout(1_000))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED', details: { sessionId: 'session-1', code: 'BRIDGE_STOPPED' },
    })
    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce())
    h.runtime.dispose()
    complete({ selected: { provider: 'provider', model: 'model/v2' } })
    await rejected
    expect(h.calls.prompt).toEqual([])
  })

  it.each([
    { provider: 'different', model: 'model/v2', reasoningEffort: 'max' },
    { provider: 'provider', model: 'different', reasoningEffort: 'max' },
    { provider: 'provider', model: 'model/v2', reasoningEffort: 'low' },
  ])('rejects a mismatched Host acknowledgement without prompting: %j', async selected => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.controller, 'selectModel').mockResolvedValueOnce({ selected })
    await expect(h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2', reasoningEffort: 'max' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED', details: { sessionId: 'session-1', code: 'MODEL_SELECTION_MISMATCH' },
    })
    expect(h.calls.prompt).toEqual([])
  })

  it('rejects a malformed Host selection acknowledgement and preserves the Session id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.controller, 'selectModel').mockResolvedValueOnce({} as Awaited<ReturnType<SessionControllerLike['selectModel']>>)
    await expect(h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED', details: { sessionId: 'session-1', code: 'INVALID_MODEL_SELECTION' },
    })
    expect(h.calls.prompt).toEqual([])
  })

  it('bounds long post-create errors while retaining failure and Session identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.controller, 'prompt').mockRejectedValueOnce(new Error('x'.repeat(20_000)))
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED', details: { sessionId: 'session-1', cause: 'x'.repeat(2_048) + ' [truncated]' },
    })
  })
})

describe('BridgeRuntime tracking', () => {
  it('completes only from a durable turn/end and exposes incremental cursors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    await h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    h.setRunning(true)
    h.runtime.tracker.recordHostStatus('session-1', true)
    const before = await h.runtime.follow({ sessionId: 'session-1', limit: 100 }, AbortSignal.timeout(1_000))
    expect(before.status.status).toBe('running')
    h.setRunning(false)
    h.stream.emit({ type: 'event', event: { type: 'turn/end', seq: 4, time: Date.now(), data: { reason: { kind: 'stop' } } } })
    const waited = await h.runtime.wait({ sessionId: 'session-1', timeoutMs: 1_000, cursor: before.nextCursor }, AbortSignal.timeout(2_000))
    expect(waited.timedOut).toBe(false)
    expect(waited.status).toMatchObject({ status: 'completed', terminal: true, lastTurnEndSeq: 4 })
    expect(waited.events).toEqual([expect.objectContaining({ eventType: 'turn/end', durableSeq: 4 })])
  })

  it('returns idle after an actual Host running-to-idle transition without claiming completion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    await h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    h.setRunning(true)
    h.runtime.tracker.recordHostStatus('session-1', true)
    const waiting = h.runtime.wait({ sessionId: 'session-1', timeoutMs: 1_000 }, AbortSignal.timeout(2_000))
    h.setRunning(false)
    h.runtime.tracker.recordHostStatus('session-1', false)
    const waited = await waiting
    expect(waited.timedOut).toBe(false)
    expect(waited.status).toMatchObject({ status: 'idle', terminal: false })
    expect(waited.status.lastTurnEndSeq).toBeUndefined()
  })

  it('times out without cancelling and cancel calls only controller.cancel', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    await h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    const waited = await h.runtime.wait({ sessionId: 'session-1', timeoutMs: 5 }, AbortSignal.timeout(1_000))
    expect(waited.timedOut).toBe(true)
    expect(h.calls.cancel).toEqual([])
    await expect(h.runtime.cancel('session-1')).resolves.toMatchObject({ bridgeAccepted: true, dsh: { accepted: true }, status: 'cancelled' })
    expect(h.calls.cancel).toEqual([{ sessionId: 'session-1' }])
  })

  it('rejects cursors from a previous bridge generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-runtime-'))
    const h = harness()
    runtimes.push(h.runtime)
    await h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    const stale = `${crypto.randomUUID()}.${Buffer.from('session-1').toString('base64url')}.0`
    await expect(h.runtime.follow({ sessionId: 'session-1', cursor: stale, limit: 10 }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
  })
})
