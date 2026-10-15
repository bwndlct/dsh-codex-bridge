import { describe, expect, it } from 'vitest'
import { EventTracker } from '../src/tracker.js'
import type { FollowFrame, SessionControllerLike, SessionSummary } from '../src/types.js'

class SessionStreams {
  private readonly queues = new Map<string, FollowFrame[]>()
  private readonly wakes = new Map<string, () => void>()
  readonly followed: string[] = []

  emit(sessionId: string, frame: FollowFrame): void {
    const queue = this.queues.get(sessionId) ?? []
    queue.push(frame)
    this.queues.set(sessionId, queue)
    this.wakes.get(sessionId)?.()
    this.wakes.delete(sessionId)
  }

  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<FollowFrame> {
    this.followed.push(sessionId)
    yield { type: 'snapshot', cursor: -1, records: [] }
    while (!signal.aborted) {
      const frame = this.queues.get(sessionId)?.shift()
      if (frame !== undefined) yield frame
      else await new Promise<void>(resolve => {
        this.wakes.set(sessionId, resolve)
        signal.addEventListener('abort', resolve, { once: true })
      })
    }
  }
}

function harness(maxSessions = 10) {
  const streams = new SessionStreams()
  const items: SessionSummary[] = [
    { sessionId: 's1', running: false, agentAvailable: true, blank: false, updatedAt: 1 },
    { sessionId: 's2', running: false, agentAvailable: true, blank: false, updatedAt: 2 },
  ]
  const controller = {
    async list() { return { items } },
    follow(request, signal) { return streams.follow(request.address.sessionId, signal) },
  } as Pick<SessionControllerLike, 'list' | 'follow'> as SessionControllerLike
  const tracker = new EventTracker(controller, crypto.randomUUID(), 32, maxSessions)
  return { tracker, items, streams }
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const limit = Date.now() + 1_000
  while (!await check()) {
    if (Date.now() > limit) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('EventTracker lifecycle', () => {
  it('prioritizes raw running, resets on a new turn, and completes on its next end', async () => {
    const h = harness()
    h.tracker.start('s1')
    h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: {} } })
    await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).status === 'completed')
    expect((await h.tracker.status('s1', AbortSignal.timeout(100))).status).toBe('completed')

    h.items[0] = { ...h.items[0]!, running: true }
    expect((await h.tracker.status('s1', AbortSignal.timeout(100))).status).toBe('running')
    h.streams.emit('s1', { type: 'event', event: { type: 'turn/start', seq: 3, time: 3, data: {} } })
    h.items[0] = { ...h.items[0]!, running: false }
    h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 4, time: 4, data: {} } })
    await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).lastTurnEndSeq === 4)
    expect(await h.tracker.status('s1', AbortSignal.timeout(100))).toMatchObject({ status: 'completed', lastTurnEndSeq: 4 })
    h.tracker.stopAll()
  })

  it('rejects future and cross-session cursors', async () => {
    const h = harness()
    h.tracker.start('s1')
    h.tracker.start('s2')
    h.tracker.recordHostStatus('s1', true)
    const first = await h.tracker.follow('s1', undefined, 10, AbortSignal.timeout(100))
    expect(first.nextCursor).toBeDefined()
    const future = first.nextCursor!.replace(/\.\d+$/, '.999')
    await expect(h.tracker.follow('s1', future, 10, AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await expect(h.tracker.follow('s2', first.nextCursor, 10, AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'CURSOR_SESSION_MISMATCH' })
    h.tracker.stopAll()
  })

  it('never evicts an active session and evicts inactive LRU only', () => {
    const h = harness(1)
    h.tracker.start('s1')
    expect(() => h.tracker.start('s2')).toThrowError(expect.objectContaining({ code: 'TRACKER_CAPACITY' }))
    h.tracker.recordCancelled('s1')
    h.tracker.recordHostStatus('s1', false)
    expect(() => h.tracker.start('s2')).not.toThrow()
    h.tracker.stopAll()
  })

  it('adopts a valid idle session after restart and rejects stale cursors', async () => {
    const h = harness()
    const status = await h.tracker.status('s1', AbortSignal.timeout(100))
    expect(status.sessionId).toBe('s1')
    await waitUntil(() => h.streams.followed.includes('s1'))
    await expect(h.tracker.follow('s1', `${crypto.randomUUID()}.czE.0`, 10, AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
    const waited = await h.tracker.wait('s1', undefined, 5, AbortSignal.timeout(100))
    expect(waited.timedOut).toBe(false)
    expect(waited.follow.status.status).toBe('idle')
    h.tracker.stopAll()
  })

  it('reserves capacity atomically and releases reservations only once', async () => {
    const h = harness(1)
    const release = h.tracker.reserveCapacity()
    expect(() => h.tracker.reserveCapacity()).toThrowError(expect.objectContaining({ code: 'TRACKER_CAPACITY' }))
    await expect(h.tracker.status('s1', AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'TRACKER_CAPACITY' })
    release()
    release()
    h.tracker.start('s1')
    expect(() => h.tracker.start('s2')).toThrowError(expect.objectContaining({ code: 'TRACKER_CAPACITY' }))
    h.tracker.stopAll()
  })

  it('can evict adopted blank sessions but protects newly delegated sessions', async () => {
    const h = harness(1)
    h.items[0] = { ...h.items[0]!, blank: true, agentAvailable: false }
    expect((await h.tracker.status('s1', AbortSignal.timeout(100))).status).toBe('idle')
    h.tracker.start('s2')
    h.items[1] = { ...h.items[1]!, blank: true, agentAvailable: false }
    expect((await h.tracker.status('s2', AbortSignal.timeout(100))).status).toBe('queued')
    expect(() => h.tracker.start('s1')).toThrowError(expect.objectContaining({ code: 'TRACKER_CAPACITY' }))
    h.tracker.stopAll()
  })

  it('upgrades an adopted session when delegation starts without a duplicate subscription', async () => {
    const h = harness(1)
    await h.tracker.status('s1', AbortSignal.timeout(100))
    h.tracker.start('s1')
    h.tracker.start('s1', false)
    expect((await h.tracker.status('s1', AbortSignal.timeout(100))).status).toBe('queued')
    expect(() => h.tracker.start('s2')).toThrowError(expect.objectContaining({ code: 'TRACKER_CAPACITY' }))
    expect(h.streams.followed).toEqual(['s1'])
    h.tracker.stopAll()
  })

  it('expires old cursors when an evicted session is adopted again within the same bridge instance', async () => {
    const h = harness(1)
    await h.tracker.status('s1', AbortSignal.timeout(100))
    h.tracker.recordHostStatus('s1', false)
    const old = await h.tracker.follow('s1', undefined, 10, AbortSignal.timeout(100))
    await h.tracker.status('s2', AbortSignal.timeout(100))
    await h.tracker.status('s1', AbortSignal.timeout(100))
    h.streams.emit('s1', { type: 'snapshot', cursor: 2, records: [
      { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } } },
    ] })
    await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
    await expect(h.tracker.follow('s1', old.nextCursor, 10, AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
    const fresh = await h.tracker.follow('s1', undefined, 10, AbortSignal.timeout(100))
    expect(fresh.events).toEqual([expect.objectContaining({ eventType: 'turn/end', durableSeq: 2 })])
    expect(fresh.nextCursor).not.toBe(old.nextCursor)
    const legacy = fresh.nextCursor!.replace(/:[^.]+\./, '.')
    await expect(h.tracker.follow('s1', legacy, 10, AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
    expect((await h.tracker.follow('s1', fresh.nextCursor, 10, AbortSignal.timeout(100))).events).toEqual([])
    h.tracker.stopAll()
  })

  it('keeps cancellation requests active until the Host confirms idle', async () => {
    const h = harness(1)
    h.tracker.start('s1')
    h.tracker.recordHostStatus('s1', true)
    h.tracker.recordCancelled('s1')
    expect(() => h.tracker.start('s2')).toThrowError(expect.objectContaining({ code: 'TRACKER_CAPACITY' }))
    h.tracker.recordHostStatus('s1', false)
    expect(() => h.tracker.start('s2')).not.toThrow()
    h.tracker.stopAll()
  })

  it('ends pending waits on disposal and never reopens subscriptions', async () => {
    const h = harness()
    h.tracker.start('s1')
    const waiting = h.tracker.wait('s1', undefined, 1_000, AbortSignal.timeout(2_000))
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'BRIDGE_STOPPED' })
    await new Promise(resolve => setTimeout(resolve, 5))
    h.tracker.stopAll()
    await rejected
    await expect(h.tracker.status('s1', AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'BRIDGE_STOPPED' })
    expect(() => h.tracker.start('s2')).toThrowError(expect.objectContaining({ code: 'BRIDGE_STOPPED' }))
    expect(h.streams.followed).toEqual(['s1'])
  })

  it.each(['error', 'aborted'])('restores %s outcomes from durable snapshot events', async kind => {
    const h = harness()
    h.tracker.start('s1')
    h.streams.emit('s1', { type: 'snapshot', cursor: 2, records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } },
      { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind, error: { message: 'provider failed' } } } } },
    ] })
    await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
    expect((await h.tracker.status('s1', AbortSignal.timeout(100))).status).toBe(kind === 'error' ? 'error' : 'cancelled')
    h.tracker.stopAll()
  })

  it.each(['error', 'aborted', 'completed'])('clears old %s state when only the Host list observes a new turn', async kind => {
    const h = harness()
    h.tracker.start('s1')
    h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind, error: { message: 'previous failure' } } } } })
    await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
    h.items[0] = { ...h.items[0]!, running: true }
    expect((await h.tracker.status('s1', AbortSignal.timeout(100))).status).toBe('running')
    h.items[0] = { ...h.items[0]!, running: false }
    expect(await h.tracker.status('s1', AbortSignal.timeout(100))).toMatchObject({ status: 'idle', terminal: false })
    h.tracker.stopAll()
  })

  it.each(['host', 'durable'])('bounds %s error messages without hiding failure', async source => {
    const h = harness()
    h.tracker.start('s1')
    const message = 'failure '.repeat(10_000)
    if (source === 'host') h.tracker.recordError('s1', message)
    else h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'error', error: { message } } } } })
    await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).status === 'error')
    const status = await h.tracker.status('s1', AbortSignal.timeout(100))
    expect(status.terminal).toBe(true)
    expect(status.error).toContain('[bridge error truncated]')
    expect(Buffer.byteLength(status.error!)).toBeLessThanOrEqual(1024)
    h.tracker.stopAll()
  })

  it('projects headers, drops raw requests, and pages bounded assistant output without losing cursors', async () => {
    const h = harness()
    h.tracker.start('s1')
    h.streams.emit('s1', { type: 'assistant-stream', frame: { secret: 'stream secret' } })
    for (const [type, data] of [
      ['request/context', { secret: 'request secret' }],
      ['request/header', { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'max', apiKey: 'credential secret' }, messages: 'prompt secret' } }],
      ['permission/preset', { preset: 'default', secret: 'permission secret' }],
      ['sandbox/mode', { mode: 'workspace', source: 'preset', config: 'sandbox secret' }],
      ['approval/policy', { policy: 'on-request', source: 'preset', config: 'approval secret' }],
      ...Array.from({ length: 20 }, () => ['assistant/message', { text: 'x'.repeat(10_000) }]),
      ['turn/end', { reason: { kind: 'completed' } }],
    ] as [string, unknown][]) {
      h.streams.emit('s1', { type: 'event', event: { type, data, seq: Date.now(), time: 1 } })
    }
    await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
    let cursor: string | undefined
    let count = 0
    do {
      const page = await h.tracker.follow('s1', cursor, 500, AbortSignal.timeout(100))
      expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(16 * 1024)
      expect(page.truncated).toBe(false)
      expect(JSON.stringify(page.events)).not.toContain('secret')
      if (page.events.length === 0) break
      if (count === 0) {
        expect(page.events[0]!.data).toEqual({ config: { provider: 'p', model: 'm', reasoningEffort: 'max' } })
        expect(page.events[1]!.data).toEqual({ preset: 'default' })
        expect(page.events[2]!.data).toEqual({ mode: 'workspace', source: 'preset' })
        expect(page.events[3]!.data).toEqual({ policy: 'on-request', source: 'preset' })
        expect(page.events[4]!.data).toMatchObject({ bridgeContentTruncated: true })
      }
      count += page.events.length
      expect(page.nextCursor).not.toBe(cursor)
      cursor = page.nextCursor
    } while (true)
    expect(count).toBe(25)
    h.tracker.stopAll()
  })
})
