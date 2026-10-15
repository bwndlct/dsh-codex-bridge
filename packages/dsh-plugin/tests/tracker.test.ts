import { describe, expect, it } from 'vitest'
import type { FollowResponse, TrackedEvent } from '@dsh-codex-bridge/protocol'
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

function harness(maxSessions = 10, eventLimit = 32) {
  const streams = new SessionStreams()
  const items: SessionSummary[] = [
    { sessionId: 's1', running: false, agentAvailable: true, blank: false, updatedAt: 1 },
    { sessionId: 's2', running: false, agentAvailable: true, blank: false, updatedAt: 2 },
  ]
  const controller = {
    async list() { return { items } },
    follow(request, signal) { return streams.follow(request.address.sessionId, signal) },
  } as Pick<SessionControllerLike, 'list' | 'follow'> as SessionControllerLike
  const tracker = new EventTracker(controller, crypto.randomUUID(), eventLimit, maxSessions)
  return { tracker, items, streams }
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const limit = Date.now() + 1_000
  while (!await check()) {
    if (Date.now() > limit) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface JsonChunk {
  readonly bridgeContentChunk: true
  readonly id: string
  readonly index: number
  readonly total: number
  readonly encoding: 'json'
  readonly text: string
}

function expectBoundedPage(page: FollowResponse): void {
  expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(16 * 1024)
  for (const event of page.events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(4 * 1024)
}

async function readAll(tracker: EventTracker, cursor?: string): Promise<{ pages: FollowResponse[]; events: TrackedEvent[]; nextCursor: string | undefined }> {
  const pages: FollowResponse[] = []
  const events: TrackedEvent[] = []
  do {
    const page = await tracker.follow('s1', cursor, 500, AbortSignal.timeout(100))
    expectBoundedPage(page)
    pages.push(page)
    events.push(...page.events)
    if (page.events.length > 0) {
      expect(page.nextCursor).toBe(page.events.at(-1)!.cursor)
      expect(page.nextCursor).not.toBe(cursor)
    }
    if (page.hasMore) expect(page.events.length).toBeGreaterThan(0)
    cursor = page.nextCursor
    expect(pages.length).toBeLessThan(100)
    if (!page.hasMore) break
  } while (true)
  expect(new Set(events.map(event => event.cursor)).size).toBe(events.length)
  return { pages, events, nextCursor: cursor }
}

function decodeChunks(events: readonly TrackedEvent[]): unknown {
  expect(events.length).toBeGreaterThan(1)
  const chunks = events.map(event => event.data as JsonChunk)
  const first = chunks[0]!
  expect(first.id).toBe(events[0]!.cursor)
  expect(first.total).toBe(events.length)
  expect(chunks.map(chunk => chunk.index)).toEqual(Array.from({ length: first.total }, (_, index) => index))
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk).toMatchObject({ bridgeContentChunk: true, id: first.id, total: first.total, encoding: 'json' })
    expect(typeof chunk.text).toBe('string')
    expect(events[index]).toMatchObject({
      kind: events[0]!.kind,
      eventType: events[0]!.eventType,
      durableSeq: events[0]!.durableSeq,
      time: events[0]!.time,
    })
    expect(Buffer.byteLength(JSON.stringify(events[index]))).toBeLessThanOrEqual(4 * 1024)
  }
  expect(new Set(events.map(event => event.cursor)).size).toBe(events.length)
  return JSON.parse(chunks.map(chunk => chunk.text).join('')) as unknown
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

  it('projects headers and drops raw request and assistant-stream frames', async () => {
    const h = harness()
    h.tracker.start('s1')
    try {
      h.streams.emit('s1', { type: 'assistant-stream', frame: { secret: 'stream secret' } })
      const frames: [string, unknown][] = [
        ['request/context', { secret: 'request secret' }],
        ['request/header', { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'max', apiKey: 'credential secret' }, messages: 'prompt secret' } }],
        ['permission/preset', { preset: 'default', secret: 'permission secret' }],
        ['sandbox/mode', { mode: 'workspace', source: 'preset', config: 'sandbox secret' }],
        ['approval/policy', { policy: 'on-request', source: 'preset', config: 'approval secret' }],
        ['turn/end', { reason: { kind: 'completed' } }],
      ]
      for (const [index, [type, data]] of frames.entries()) {
        h.streams.emit('s1', { type: 'event', event: { type, data, seq: index + 1, time: 1 } })
      }
      await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
      const page = await h.tracker.follow('s1', undefined, 500, AbortSignal.timeout(100))
      expectBoundedPage(page)
      expect(page).toMatchObject({ truncated: false, hasMore: false })
      expect(JSON.stringify(page.events)).not.toContain('secret')
      expect(page.events.map(event => event.data)).toEqual([
        { config: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
        { preset: 'default' },
        { mode: 'workspace', source: 'preset' },
        { policy: 'on-request', source: 'preset' },
        { reason: { kind: 'completed' } },
      ])
    } finally {
      h.tracker.stopAll()
    }
  })

  it('preserves a short final after preceding reasoning while removing a large internal stream', async () => {
    const h = harness()
    const tail = 'synthetic-final-tail:完🙂'
    const text = 'synthetic result '.repeat(60) + tail
    const content = [
      { type: 'reasoning', text: 'synthetic rationale '.repeat(75) },
      { type: 'text', text },
      { type: 'tool-call', id: 'call-1', name: 'synthetic_tool', arguments: { value: 'fixture' } },
    ]
    const source = { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }
    const projected = { turn: 3, step: 2, message: { id: 'message-final', role: 'assistant', content, source } }
    const data = {
      ...projected,
      message: { ...projected.message, source: { ...source, replayState: { trace: 'excluded-replay' }, internal: 'excluded-source' } },
      stream: [{ type: 'text-delta', text: 's'.repeat(7 * 1024) }],
    }
    const original = JSON.stringify(data)
    expect(Buffer.byteLength(text)).toBeLessThan(1_100)
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(3_500)
    expect(Buffer.byteLength(original)).toBeGreaterThan(7 * 1024)
    expect(original.slice(0, 1_000)).not.toContain(tail)
    h.tracker.start('s1')
    try {
      h.streams.emit('s1', { type: 'event', event: { type: 'assistant/message', seq: 1, time: 7, data } })
      h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 2, time: 8, data: { reason: { kind: 'completed' } } } })
      await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
      const page = await h.tracker.follow('s1', undefined, 500, AbortSignal.timeout(100))
      expectBoundedPage(page)
      expect(page).toMatchObject({ hasMore: false, truncated: false, status: { status: 'completed' } })
      const messages = page.events.filter(event => event.eventType === 'assistant/message')
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ durableSeq: 1, time: 7, data: projected })
      expect(messages[0]!.data).toEqual(projected)
      const received = messages[0]!.data as typeof projected
      expect(Buffer.from(JSON.stringify(received.message.content))).toEqual(Buffer.from(JSON.stringify(content)))
      expect(received.message.content[1]!.text).toBe(text)
      expect(received.message.content[1]!.text!.endsWith(tail)).toBe(true)
      expect(JSON.stringify(page.events)).not.toMatch(/excluded-replay|excluded-source|text-delta/)
      expect(JSON.stringify(data)).toBe(original)
    } finally {
      h.tracker.stopAll()
    }
  })

  it('reassembles long escaped UTF-8 content across bounded pages with repeatable cursors', async () => {
    const h = harness(10, 128)
    const tail = 'synthetic-long-final-tail:終🙂e\u0301'
    const text = '跨页🙂e\u0301 "quoted" \\\n\t\u0000'.repeat(1_400) + tail
    const projected = {
      turn: 4,
      step: 1,
      message: {
        id: 'message-long',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'reasoning before the visible answer '.repeat(120) },
          { type: 'text', text: 'first block\n' },
          { type: 'tool-call', id: 'call-long', name: 'synthetic_tool', arguments: { nested: ['甲', '\\', '"', '\n'] } },
          { type: 'text', text },
        ],
      },
    }
    h.tracker.start('s1')
    try {
      h.streams.emit('s1', { type: 'event', event: { type: 'assistant/message', seq: 10, time: 10, data: projected } })
      h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 11, time: 11, data: { reason: { kind: 'completed' } } } })
      await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
      const first = await h.tracker.follow('s1', undefined, 500, AbortSignal.timeout(100))
      expect(first).toMatchObject({ hasMore: true, truncated: false, status: { status: 'completed', terminal: true } })
      expect(first.nextCursor).not.toBe(first.status.lastCursor)
      expect(await h.tracker.follow('s1', undefined, 500, AbortSignal.timeout(100))).toEqual(first)
      const waited = await h.tracker.wait('s1', undefined, 1_000, AbortSignal.timeout(100))
      expect(waited).toEqual({ timedOut: false, follow: first })
      const received = await readAll(h.tracker)
      expect(received.pages.length).toBeGreaterThan(1)
      expect(received.pages.every(page => !page.truncated && page.status.status === 'completed')).toBe(true)
      const messages = received.events.filter(event => event.eventType === 'assistant/message')
      const restored = decodeChunks(messages) as typeof projected
      expect(restored).toEqual(projected)
      expect(Buffer.from(JSON.stringify(restored.message.content))).toEqual(Buffer.from(JSON.stringify(projected.message.content)))
      expect(Buffer.from(restored.message.content[3]!.text!)).toEqual(Buffer.from(text))
      expect(restored.message.content[3]!.text!.endsWith(tail)).toBe(true)
      expect(restored.message.content[3]!.text).not.toContain('\ufffd')
      expect(received.events.at(-1)).toMatchObject({ eventType: 'turn/end', durableSeq: 11 })
      expect(received.nextCursor).toBe(first.status.lastCursor)
      const empty = await h.tracker.follow('s1', received.nextCursor, 500, AbortSignal.timeout(100))
      expect(empty).toMatchObject({ events: [], nextCursor: received.nextCursor, hasMore: false, truncated: false })
    } finally {
      h.tracker.stopAll()
    }
  })

  it('keeps hasMore true after completion until the latest final and end have been read', async () => {
    const h = harness()
    const final = { message: { id: 'latest-final', role: 'assistant', content: [{ type: 'text', text: 'latest final tail:終🙂' }] } }
    h.tracker.start('s1')
    try {
      for (let seq = 1; seq <= 12; seq += 1) {
        h.streams.emit('s1', { type: 'event', event: {
          type: 'assistant/message', seq, time: seq,
          data: { message: { role: 'assistant', content: [{ type: 'text', text: `progress-${String(seq)}:` + 'p'.repeat(2_700) }] } },
        } })
      }
      h.streams.emit('s1', { type: 'event', event: { type: 'assistant/message', seq: 13, time: 13, data: final } })
      h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 14, time: 14, data: { reason: { kind: 'completed' } } } })
      await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
      const first = (await h.tracker.wait('s1', undefined, 1_000, AbortSignal.timeout(100))).follow
      expect(first).toMatchObject({ status: { status: 'completed', terminal: true }, truncated: false, hasMore: true })
      expect(first.events.some(event => event.durableSeq === 13 || event.durableSeq === 14)).toBe(false)
      expect(first.nextCursor).not.toBe(first.status.lastCursor)
      const single = await h.tracker.follow('s1', undefined, 1, AbortSignal.timeout(100))
      expect(single.events).toEqual(first.events.slice(0, 1))
      expect(single.hasMore).toBe(true)
      const rest = await readAll(h.tracker, first.nextCursor)
      const all = [...first.events, ...rest.events]
      expect(all.map(event => event.durableSeq)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1))
      expect(all.find(event => event.durableSeq === 13)!.data).toEqual(final)
      expect(rest.pages.at(-1)).toMatchObject({ hasMore: false, truncated: false })
      expect(rest.nextCursor).toBe(first.status.lastCursor)
    } finally {
      h.tracker.stopAll()
    }
  })

  it('marks a history gap when ring eviction leaves only the tail of a chunk group', async () => {
    const h = harness(10, 4)
    h.tracker.start('s1')
    try {
      h.tracker.recordHostStatus('s1', false)
      const before = await h.tracker.follow('s1', undefined, 500, AbortSignal.timeout(100))
      const data = { message: { role: 'assistant', content: [{ type: 'text', text: 'ring fixture 🙂 '.repeat(2_000) + 'ring-final-tail' }] } }
      h.streams.emit('s1', { type: 'event', event: { type: 'assistant/message', seq: 1, time: 1, data } })
      h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } } })
      await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
      const page = await h.tracker.follow('s1', before.nextCursor, 500, AbortSignal.timeout(100))
      expectBoundedPage(page)
      expect(page).toMatchObject({ truncated: true, hasMore: false, status: { status: 'completed' } })
      expect((await h.tracker.follow('s1', undefined, 500, AbortSignal.timeout(100))).truncated).toBe(true)
      const messages = page.events.filter(event => event.eventType === 'assistant/message')
      expect(messages).toHaveLength(3)
      const chunks = messages.map(event => event.data as JsonChunk)
      const first = chunks[0]!
      expect(first).toMatchObject({ bridgeContentChunk: true, encoding: 'json' })
      expect(first.index).toBeGreaterThan(0)
      expect(first.total).toBeGreaterThan(chunks.length)
      expect(chunks.every(chunk => chunk.id === first.id && chunk.total === first.total)).toBe(true)
      expect(chunks.map(chunk => chunk.index)).toEqual(Array.from({ length: chunks.length }, (_, index) => first.index + index))
      expect(chunks.at(-1)!.index).toBe(first.total - 1)
      expect(page.events.some(event => event.cursor === first.id)).toBe(false)
      expect(page.events.at(-1)).toMatchObject({ eventType: 'turn/end', durableSeq: 2 })
    } finally {
      h.tracker.stopAll()
    }
  })

  it.each(['error', 'aborted'] as const)('preserves a chunked %s outcome while paging its terminal records', async kind => {
    const h = harness(10, 128)
    const failure = 'synthetic failure 🙂 '.repeat(2_000) + 'failure-final-tail'
    const data = { reason: { kind, ...(kind === 'error' ? { error: { message: failure } } : {}) }, detail: 'terminal detail '.repeat(2_000) }
    h.tracker.start('s1')
    try {
      h.streams.emit('s1', { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data } })
      await waitUntil(async () => (await h.tracker.status('s1', AbortSignal.timeout(100))).terminal)
      const first = await h.tracker.wait('s1', undefined, 1_000, AbortSignal.timeout(100))
      const status = kind === 'error' ? 'error' : 'cancelled'
      expect(first).toMatchObject({ timedOut: false, follow: { hasMore: true, truncated: false, status: { status, terminal: true } } })
      const received = await readAll(h.tracker)
      expect(received.pages.every(page => page.status.status === status && !page.truncated)).toBe(true)
      expect(decodeChunks(received.events)).toEqual(data)
      if (kind === 'error') {
        expect(first.follow.status.error).toContain('[bridge error truncated]')
        expect(Buffer.byteLength(first.follow.status.error!)).toBeLessThanOrEqual(1_024)
      } else expect(first.follow.status.error).toBeUndefined()
    } finally {
      h.tracker.stopAll()
    }
  })
})
