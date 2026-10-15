import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { connectionFileSchema, delegateResponseSchema, followResponseSchema, waitResponseSchema, type FollowResponse } from '@dsh-codex-bridge/protocol'
import { BridgeHttpServer } from '../src/server.js'
import { BridgeRuntime } from '../src/runtime.js'
import type { BridgeContext, FollowFrame, SessionControllerLike, WireEvent } from '../src/types.js'

function runtime() {
  return {
    instanceId: crypto.randomUUID(),
    dispose: vi.fn(),
    delegate: vi.fn(),
    status: vi.fn(),
    follow: vi.fn(),
    wait: vi.fn(),
    cancel: vi.fn(),
  } as unknown as BridgeRuntime
}

async function start(bridge = runtime()) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-http-'))
  const connectionFile = join(directory, 'run', 'bridge.json')
  const server = new BridgeHttpServer(bridge, { port: 0, connectionFile, token: 't'.repeat(32) })
  const connection = await server.start()
  return { bridge, connectionFile, server, connection }
}

describe('loopback server', () => {
  it('requires bearer auth, writes mode 0600 discovery, and removes only its file', async () => {
    const h = await start()
    expect(h.connection.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(connectionFileSchema.parse(JSON.parse(await readFile(h.connectionFile, 'utf8')))).toEqual(h.connection)
    expect((await stat(h.connectionFile)).mode & 0o777).toBe(0o600)

    const unauthorized = await fetch(`${h.connection.endpoint}/v1/health`)
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })

    const healthy = await fetch(`${h.connection.endpoint}/v1/health`, { headers: { authorization: `Bearer ${h.connection.token}` } })
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toMatchObject({ ok: true })

    await h.server.stop()
    await expect(readFile(h.connectionFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.bridge.dispose).toHaveBeenCalledOnce()
  })

  it('rejects malformed and oversized request bodies before dispatch', async () => {
    const h = await start()
    const headers = { authorization: `Bearer ${h.connection.token}`, 'content-type': 'application/json' }
    const malformed = await fetch(`${h.connection.endpoint}/v1/status`, { method: 'POST', headers, body: '{' })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_JSON' } })

    const oversized = await fetch(`${h.connection.endpoint}/v1/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: 'x'.repeat(1_048_576) }),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } })
    expect(h.bridge.status).not.toHaveBeenCalled()
    await h.server.stop()
  })

  it('reads a completed final over repeated HTTP pages without delegating or prompting again', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-http-task-'))
    const tail = 'http-final-tail:終🙂e\u0301'
    const text = 'HTTP 合成🙂e\u0301 "quoted" \\\n\t\u0000'.repeat(1_200) + tail
    const final = {
      turn: 1,
      step: 9,
      message: { id: 'http-final', role: 'assistant', content: [{ type: 'reasoning', text: 'synthetic reasoning first' }, { type: 'text', text }] },
    }
    const records: { type: 'event'; event: WireEvent }[] = Array.from({ length: 8 }, (_, index) => ({
      type: 'event',
      event: {
        type: 'assistant/message', seq: index + 1, time: index + 1,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic progress '.repeat(150) }] } },
      },
    }))
    records.push(
      { type: 'event', event: { type: 'assistant/message', seq: 100, time: 100, data: { ...final, stream: [{ text: 'internal stream '.repeat(600) }] } } },
      { type: 'event', event: { type: 'turn/end', seq: 101, time: 101, data: { reason: { kind: 'completed' } } } },
    )
    const create = vi.fn(async () => ({ sessionId: 'http-session' }))
    const prompt = vi.fn(async () => ({ accepted: true as const }))
    const list = vi.fn(async () => ({ items: [{ sessionId: 'http-session', running: false, agentAvailable: true, blank: false, updatedAt: 101 }] }))
    const follow = vi.fn(async function* (_request: unknown, signal: AbortSignal): AsyncIterable<FollowFrame> {
      yield { type: 'snapshot', cursor: 101, records }
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const controller = { create, prompt, list, follow } as unknown as SessionControllerLike
    const bridge = new BridgeRuntime({ sessionController: controller, workspaceRegistry: { list: () => [] } } as unknown as BridgeContext, crypto.randomUUID(), 128, 10)
    const h = await start(bridge)
    const post = async (path: string, body: unknown): Promise<unknown> => {
      const response = await fetch(h.connection.endpoint + path, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + h.connection.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2_000),
      })
      expect(response.status).toBe(200)
      return await response.json() as unknown
    }
    try {
      const delegated = delegateResponseSchema.parse(await post('/v1/delegate', { task: 'synthetic pagination fixture', cwd }))
      expect(delegated.sessionId).toBe('http-session')
      const first = waitResponseSchema.parse(await post('/v1/wait', { sessionId: delegated.sessionId, timeoutMs: 1_000 }))
      expect(first).toMatchObject({ timedOut: false, hasMore: true, truncated: false, status: { status: 'completed', terminal: true } })
      expect(first.events.some(event => event.durableSeq === 100 || event.durableSeq === 101)).toBe(false)
      expect(first.nextCursor).not.toBe(first.status.lastCursor)
      expect(waitResponseSchema.parse(await post('/v1/wait', { sessionId: delegated.sessionId, timeoutMs: 1_000 }))).toEqual(first)
      let page: FollowResponse = first
      const events = [...first.events]
      let pages = 1
      const expectBudget = (value: FollowResponse): void => {
        expect(Buffer.byteLength(JSON.stringify(value.events))).toBeLessThanOrEqual(16 * 1024)
        for (const event of value.events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(4 * 1024)
      }
      expectBudget(first)
      while (page.hasMore) {
        const cursor = page.nextCursor
        expect(cursor).toBeDefined()
        const request = { sessionId: delegated.sessionId, cursor, limit: 500 }
        page = followResponseSchema.parse(await post('/v1/follow', request))
        expect(followResponseSchema.parse(await post('/v1/follow', request))).toEqual(page)
        expectBudget(page)
        expect(page).toMatchObject({ truncated: false, status: { status: 'completed', terminal: true } })
        expect(page.events.length).toBeGreaterThan(0)
        expect(page.nextCursor).toBe(page.events.at(-1)!.cursor)
        expect(page.nextCursor).not.toBe(cursor)
        events.push(...page.events)
        pages += 1
        expect(pages).toBeLessThan(100)
      }
      expect(pages).toBeGreaterThan(2)
      expect(new Set(events.map(event => event.cursor)).size).toBe(events.length)
      const chunks = events.filter(event => event.durableSeq === 100)
      expect(chunks.length).toBeGreaterThan(1)
      const firstChunk = chunks[0]!.data as { id: string; total: number }
      expect(firstChunk.id).toBe(chunks[0]!.cursor)
      expect(firstChunk.total).toBe(chunks.length)
      const pieces = chunks.map((event, index) => {
        expect(event).toMatchObject({ kind: 'dsh-event', eventType: 'assistant/message', durableSeq: 100, time: 100 })
        expect(event.data).toMatchObject({ bridgeContentChunk: true, id: firstChunk.id, index, total: chunks.length, encoding: 'json' })
        return (event.data as { text: string }).text
      })
      const restored = JSON.parse(pieces.join('')) as typeof final
      expect(restored).toEqual(final)
      expect(Buffer.from(JSON.stringify(restored.message.content))).toEqual(Buffer.from(JSON.stringify(final.message.content)))
      expect(Buffer.from(restored.message.content[1]!.text)).toEqual(Buffer.from(text))
      expect(restored.message.content[1]!.text.endsWith(tail)).toBe(true)
      expect(events.at(-1)).toMatchObject({ eventType: 'turn/end', durableSeq: 101 })
      expect(page.nextCursor).toBe(first.status.lastCursor)
      const empty = waitResponseSchema.parse(await post('/v1/wait', { sessionId: delegated.sessionId, cursor: page.nextCursor, timeoutMs: 1_000 }))
      expect(empty).toMatchObject({ events: [], nextCursor: page.nextCursor, hasMore: false, truncated: false, timedOut: false, status: { status: 'completed' } })
      expect(create).toHaveBeenCalledOnce()
      expect(prompt).toHaveBeenCalledOnce()
      expect(follow).toHaveBeenCalledOnce()
    } finally {
      await h.server.stop()
    }
  })

  it('aborts a long wait when the HTTP client disconnects', async () => {
    const bridge = runtime()
    let disconnected!: () => void
    const observed = new Promise<void>(resolve => { disconnected = resolve })
    vi.mocked(bridge.wait).mockImplementation(async (_request, signal) => {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          disconnected()
          reject(signal.reason)
        }, { once: true })
      })
    })
    const h = await start(bridge)
    const url = new URL('/v1/wait', h.connection.endpoint)
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.connection.token}`,
        'content-type': 'application/json',
      },
    })
    request.on('error', () => {})
    request.end(JSON.stringify({ sessionId: 's1', timeoutMs: 60_000 }))
    await vi.waitFor(() => expect(bridge.wait).toHaveBeenCalledOnce())
    request.destroy()
    await expect(observed).resolves.toBeUndefined()
    await h.server.stop()
  })

  it('stops an in-flight HTTP wait immediately without restarting Host subscriptions', async () => {
    const list = vi.fn(async () => ({ items: [{ sessionId: 's1', running: true, agentAvailable: true, blank: false, updatedAt: 1 }] }))
    const follow = vi.fn(async function* (_request: unknown, signal: AbortSignal) {
      yield { type: 'snapshot', cursor: -1, records: [] }
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const controller = { list, follow } as unknown as SessionControllerLike
    const bridge = new BridgeRuntime({ sessionController: controller } as BridgeContext, crypto.randomUUID(), 32, 10)
    const h = await start(bridge)
    try {
      const pending = fetch(h.connection.endpoint + '/v1/wait', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + h.connection.token, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', timeoutMs: 60_000 }),
        signal: AbortSignal.timeout(2_000),
      })
      await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2))
      const stopped = h.server.stop()
      const response = await pending
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: 'BRIDGE_STOPPED' } })
      await stopped
      expect(follow).toHaveBeenCalledOnce()
      await expect(bridge.status('s1', AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'BRIDGE_STOPPED' })
    } finally {
      await h.server.stop()
    }
  })
})
