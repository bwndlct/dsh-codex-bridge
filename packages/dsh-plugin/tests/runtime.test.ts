import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function harness(workspaceId?: string, failPrompt = false) {
  const stream = new FrameStream()
  let running = false
  const calls: { create: unknown[]; workspaceCreate: string[]; prompt: unknown[]; select: unknown[]; cancel: unknown[]; order: string[] } = {
    create: [], workspaceCreate: [], prompt: [], select: [], cancel: [], order: [],
  }
  const controller: SessionControllerLike = {
    async create(request) { calls.order.push('create'); calls.create.push(request); return { sessionId: 'session-1' } },
    async modelCatalog() { calls.order.push('modelCatalog'); return { default: { provider: 'provider', model: 'model/v2' }, groups: [{ id: 'provider', models: [{ id: 'model/v2', reasoning: { efforts: [{ id: 'max' }] } }] }] } },
    async selectModel(request) { calls.order.push('selectModel'); calls.select.push(request); return {} },
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
  const workspaces = new Map<string, { id: string; path: string }>()
  const registry = {
    async resolveByPath(path: string) {
      calls.order.push('resolveWorkspace')
      return workspaceId === undefined ? workspaces.get(path) : { id: workspaceId, path }
    },
    async create(path: string) {
      calls.order.push('createWorkspace')
      calls.workspaceCreate.push(path)
      const workspace = { id: 'workspace-new', path }
      workspaces.set(path, workspace)
      return workspace
    },
  }
  const context = { sessionController: controller, workspaceRegistry: registry } as BridgeContext
  return { runtime: new BridgeRuntime(context, crypto.randomUUID(), 32, 10), stream, calls, controller, registry, setRunning(value: boolean) { running = value } }
}

const runtimes: BridgeRuntime[] = []
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose() })

describe('BridgeRuntime delegation', () => {
  it('resolves a registered workspace, inherits the Host model, and admits the exact prompt', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness('workspace-1')
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: '  do work  ', cwd }, AbortSignal.timeout(1_000))
    expect(result.sessionId).toBe('session-1')
    expect(h.calls.create).toEqual([{ workspaceId: 'workspace-1' }])
    expect(h.calls.select).toEqual([])
    expect(h.calls.order).toEqual(['resolveWorkspace', 'create', 'prompt'])
    expect(result).toMatchObject({
      cwd,
      workspace: { matched: true, id: 'workspace-1' },
    })
    expect(result.model).toBeUndefined()
    expect(h.calls.prompt).toHaveLength(1)
    expect(h.calls.prompt[0]).toMatchObject({ sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'do work' }] })
    expect((h.calls.prompt[0] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('registers canonical cwd as a workspace and validates exact provider/model', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness()
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: 'work', cwd, model: 'provider/model/v2' }, AbortSignal.timeout(1_000))
    expect(h.calls.workspaceCreate).toEqual([cwd])
    expect(h.calls.create).toEqual([{ workspaceId: 'workspace-new' }])
    expect(result.workspace).toEqual({ matched: false, id: 'workspace-new' })
    expect(h.calls.select).toEqual([{ sessionId: 'session-1', provider: 'provider', model: 'model/v2' }])
    expect(h.calls.order).toEqual(['modelCatalog', 'resolveWorkspace', 'createWorkspace', 'create', 'selectModel', 'prompt'])
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
    const h = harness('workspace-1')
    runtimes.push(h.runtime)
    const result = await h.runtime.delegate({ task: 'work', cwd, reasoningEffort: 'max' }, AbortSignal.timeout(1_000))
    expect(h.calls.select).toEqual([{ sessionId: 'session-1', provider: 'provider', model: 'model/v2', reasoningEffort: 'max' }])
    expect(result.model).toEqual({ provider: 'provider', model: 'model/v2', reasoningEffort: 'max', source: 'default' })
    expect(h.calls.order).toEqual(['modelCatalog', 'resolveWorkspace', 'create', 'selectModel', 'prompt'])
    expect(h.calls.workspaceCreate).toEqual([])
  })

  it('rejects an unavailable inherited effort before registering a workspace or creating a Session', async () => {
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
    const h = harness()
    runtimes.push(h.runtime)
    await h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))
    const result = await h.runtime.delegate({ task: 'work', cwd: alias }, AbortSignal.timeout(1_000))
    expect(h.calls.workspaceCreate).toEqual([cwd])
    expect(h.calls.create).toEqual([{ workspaceId: 'workspace-new' }, { workspaceId: 'workspace-new' }])
    expect(result).toMatchObject({ cwd, workspace: { matched: true, id: 'workspace-new' } })
  })

  it('does not create an ungrouped Session when Workspace registration fails', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'bridge-runtime-')))
    const h = harness()
    runtimes.push(h.runtime)
    vi.spyOn(h.registry, 'create').mockRejectedValue(new Error('storage refused'))
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'WORKSPACE_REGISTRATION_FAILED', details: { cwd, cause: 'storage refused' },
    })
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
    const h = harness(undefined, true)
    runtimes.push(h.runtime)
    await expect(h.runtime.delegate({ task: 'work', cwd }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'SESSION_ADMISSION_FAILED',
      details: { sessionId: 'session-1', cause: 'prompt refused' },
    })
    expect(h.calls.create).toHaveLength(1)
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
    h.stream.emit({ type: 'event', event: { type: 'turn/end', seq: 4, time: Date.now(), data: { outcome: 'stop' } } })
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
