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
    expect(() => h.tracker.start('s2')).not.toThrow()
    h.tracker.stopAll()
  })

  it('adopts a valid existing session after restart and times out without cancellation', async () => {
    const h = harness()
    const status = await h.tracker.status('s1', AbortSignal.timeout(100))
    expect(status.sessionId).toBe('s1')
    await waitUntil(() => h.streams.followed.includes('s1'))
    await expect(h.tracker.follow('s1', `${crypto.randomUUID()}.czE.0`, 10, AbortSignal.timeout(100))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
    const waited = await h.tracker.wait('s1', undefined, 5, AbortSignal.timeout(100))
    expect(waited.timedOut).toBe(true)
    h.tracker.stopAll()
  })
})
