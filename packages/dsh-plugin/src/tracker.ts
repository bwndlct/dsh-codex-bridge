import { BridgeError, type BridgeStatus, type FollowResponse, type RawDshState, type StatusResponse, type TrackedEvent } from '@dsh-codex-bridge/protocol'
import type { FollowFrame, SessionControllerLike, SessionSummary, WireEvent } from './types.js'

interface SessionTrack {
  readonly sessionId: string
  readonly abort: AbortController
  readonly events: TrackedEvent[]
  readonly listeners: Set<() => void>
  ordinal: number
  lastTouched: number
  runningSeen: boolean
  idleAfterRunning: boolean
  active: boolean
  completionFloorSeq: number
  lastTurnEndSeq?: number
  error: string | undefined
  cancelled: boolean
}

export class EventTracker {
  private readonly sessions = new Map<string, SessionTrack>()

  constructor(
    private readonly controller: SessionControllerLike,
    private readonly instanceId: string,
    private readonly eventLimit: number,
    private readonly maxSessions: number,
  ) {}

  ensureCapacity(): void {
    if (this.sessions.size < this.maxSessions) return
    const oldestInactive = [...this.sessions.values()]
      .filter(track => !track.active)
      .sort((left, right) => left.lastTouched - right.lastTouched)[0]
    if (oldestInactive === undefined) {
      throw new BridgeError('TRACKER_CAPACITY', 'All tracked sessions are active; wait for one to finish before delegating again.', 503)
    }
    oldestInactive.abort.abort()
    this.sessions.delete(oldestInactive.sessionId)
  }

  start(sessionId: string): void {
    if (this.sessions.has(sessionId)) return
    this.ensureCapacity()
    const track: SessionTrack = {
      sessionId,
      abort: new AbortController(),
      events: [],
      listeners: new Set(),
      ordinal: 0,
      lastTouched: Date.now(),
      runningSeen: false,
      idleAfterRunning: false,
      active: true,
      completionFloorSeq: -1,
      error: undefined,
      cancelled: false,
    }
    this.sessions.set(sessionId, track)
    void this.consume(track)
  }

  assertTracked(sessionId: string): void {
    this.require(sessionId)
  }

  stopAll(): void {
    for (const track of this.sessions.values()) track.abort.abort()
    this.sessions.clear()
  }

  recordHostStatus(sessionId: string, running: boolean): void {
    const track = this.sessions.get(sessionId)
    if (track === undefined) return
    if (running) {
      if (!track.active && this.hasTerminalState(track)) this.beginNextTurn(track)
      track.runningSeen = true
      track.idleAfterRunning = false
      track.active = true
    } else if (track.runningSeen) {
      track.idleAfterRunning = true
      track.active = false
    }
    this.push(track, 'status', { running }, undefined, undefined, Date.now(), true)
  }

  recordError(sessionId: string, message: string): void {
    const track = this.sessions.get(sessionId)
    if (track === undefined) return
    track.error = message
    track.active = false
    this.push(track, 'error', { message }, undefined, undefined, Date.now(), true)
  }

  recordCancelled(sessionId: string): void {
    const track = this.require(sessionId)
    track.cancelled = true
    track.active = false
    this.push(track, 'cancelled', { bridgeAccepted: true }, undefined, undefined, Date.now(), true)
  }

  async status(sessionId: string, signal: AbortSignal): Promise<StatusResponse> {
    const { track, item } = await this.locate(sessionId, signal)
    return this.project(track, item)
  }

  async follow(sessionId: string, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<FollowResponse> {
    const { track, item } = await this.locate(sessionId, signal)
    const selected = this.since(track, cursor, limit)
    return { sessionId, events: selected.events, ...selected.meta, status: this.project(track, item) }
  }

  async wait(sessionId: string, cursor: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<{ readonly timedOut: boolean; readonly follow: FollowResponse }> {
    const initial = await this.status(sessionId, signal)
    const track = this.require(sessionId)
    if (initial.terminal || initial.status === 'idle') {
      return { timedOut: false, follow: await this.follow(sessionId, cursor, 500, signal) }
    }

    let timedOut = false
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let checking = false
      let pending = false
      const cleanup = (): void => {
        clearTimeout(timer)
        track.listeners.delete(wake)
        signal.removeEventListener('abort', abort)
      }
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error === undefined) resolve()
        else reject(error)
      }
      const check = async (): Promise<void> => {
        try {
          const current = await this.status(sessionId, signal)
          if (current.terminal || current.status === 'idle') finish()
        } catch (error) {
          finish(error)
        } finally {
          checking = false
        }
        if (pending && !settled) {
          pending = false
          wake()
        }
      }
      const wake = (): void => {
        if (settled) return
        if (checking) {
          pending = true
          return
        }
        checking = true
        void check()
      }
      const abort = (): void => finish(signal.reason ?? new Error('Bridge request was aborted.'))
      const timer = setTimeout(() => {
        timedOut = true
        finish()
      }, timeoutMs)
      track.listeners.add(wake)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else wake()
    })
    return { timedOut, follow: await this.follow(sessionId, cursor, 500, signal) }
  }

  private async locate(sessionId: string, signal: AbortSignal): Promise<{ track: SessionTrack; item: SessionSummary }> {
    const listed = await this.controller.list({}, signal)
    const item = listed.items.find(candidate => candidate.sessionId === sessionId)
    if (item === undefined) throw new BridgeError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, 404)
    if (!this.sessions.has(sessionId)) this.start(sessionId)
    const track = this.require(sessionId)
    track.lastTouched = Date.now()
    if (item.running) {
      track.runningSeen = true
      track.idleAfterRunning = false
      track.active = true
    } else if (track.runningSeen && !this.isCompleted(track) && !track.cancelled && track.error === undefined) {
      track.idleAfterRunning = true
      track.active = false
    } else if (this.hasTerminalState(track)) {
      track.active = false
    }
    return { track, item }
  }

  private async consume(track: SessionTrack): Promise<void> {
    try {
      for await (const frame of this.controller.follow({
        address: { kind: 'session', sessionId: track.sessionId },
        assistantStream: true,
      }, track.abort.signal)) {
        this.consumeFrame(track, frame)
      }
    } catch (error) {
      if (!track.abort.signal.aborted) this.recordError(track.sessionId, error instanceof Error ? error.message : String(error))
    }
  }

  private consumeFrame(track: SessionTrack, frame: FollowFrame): void {
    if (frame.type === 'snapshot') {
      for (const record of frame.records) this.recordDshEvent(track, record.event)
      return
    }
    if (frame.type === 'event') {
      this.recordDshEvent(track, frame.event)
      return
    }
    this.push(track, 'assistant-stream', frame.frame)
  }

  private recordDshEvent(track: SessionTrack, event: WireEvent): void {
    let notify = false
    if (event.type === 'turn/start') {
      this.beginNextTurn(track, event.seq)
      notify = true
    } else if (event.type === 'turn/end') {
      track.lastTurnEndSeq = event.seq
      track.active = false
      notify = true
    }
    this.push(track, 'dsh-event', event.data, event.seq, event.type, event.time, notify)
  }

  private beginNextTurn(track: SessionTrack, startSeq?: number): void {
    track.completionFloorSeq = Math.max(track.completionFloorSeq, track.lastTurnEndSeq ?? -1, startSeq ?? -1)
    track.cancelled = false
    track.error = undefined
    track.idleAfterRunning = false
    track.runningSeen = true
    track.active = true
  }

  private push(
    track: SessionTrack,
    kind: TrackedEvent['kind'],
    data: unknown,
    durableSeq?: number,
    eventType?: string,
    time = Date.now(),
    notify = false,
  ): void {
    const cursor = this.cursor(track, ++track.ordinal)
    track.events.push({ cursor, kind, time, ...(durableSeq === undefined ? {} : { durableSeq }), ...(eventType === undefined ? {} : { eventType }), data })
    if (track.events.length > this.eventLimit) track.events.splice(0, track.events.length - this.eventLimit)
    track.lastTouched = Date.now()
    if (notify) for (const listener of [...track.listeners]) listener()
  }

  private since(track: SessionTrack, cursor: string | undefined, limit: number): { readonly events: TrackedEvent[]; readonly meta: Pick<FollowResponse, 'nextCursor' | 'truncated'> } {
    const ordinal = cursor === undefined ? 0 : this.parseCursor(track, cursor)
    const firstOrdinal = track.events.length === 0 ? track.ordinal + 1 : this.parseCursor(track, track.events[0]!.cursor)
    const truncated = ordinal < firstOrdinal - 1
    const events = track.events.filter(event => this.parseCursor(track, event.cursor) > ordinal).slice(0, limit)
    const nextCursor = events.at(-1)?.cursor ?? cursor
    return { events, meta: { ...(nextCursor === undefined ? {} : { nextCursor }), truncated } }
  }

  private cursor(track: SessionTrack, ordinal: number): string {
    const session = Buffer.from(track.sessionId, 'utf8').toString('base64url')
    return `${this.instanceId}.${session}.${String(ordinal)}`
  }

  private parseCursor(track: SessionTrack, cursor: string): number {
    const parts = cursor.split('.')
    if (parts.length !== 3) throw new BridgeError('INVALID_CURSOR', 'Cursor is invalid.', 400)
    const [instance, encodedSession, encodedOrdinal] = parts as [string, string, string]
    if (instance !== this.instanceId) {
      throw new BridgeError('CURSOR_EXPIRED', 'The bridge restarted; request a new cursor.', 409)
    }
    let session: string
    try {
      session = Buffer.from(encodedSession, 'base64url').toString('utf8')
    } catch {
      throw new BridgeError('INVALID_CURSOR', 'Cursor is invalid.', 400)
    }
    if (session !== track.sessionId) {
      throw new BridgeError('CURSOR_SESSION_MISMATCH', 'The cursor belongs to a different DSH session.', 409)
    }
    const ordinal = Number(encodedOrdinal)
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > track.ordinal) {
      throw new BridgeError('INVALID_CURSOR', 'Cursor ordinal is invalid or from the future.', 400)
    }
    return ordinal
  }

  private project(track: SessionTrack, item: SessionSummary): StatusResponse {
    const raw: RawDshState = {
      running: item.running,
      agentAvailable: item.agentAvailable,
      blank: item.blank,
      updatedAt: item.updatedAt,
    }
    let status: BridgeStatus
    if (item.running) status = 'running'
    else if (track.error !== undefined) status = 'error'
    else if (track.cancelled) status = 'cancelled'
    else if (this.isCompleted(track)) status = 'completed'
    else if (track.idleAfterRunning) status = 'idle'
    else status = 'queued'
    return {
      sessionId: track.sessionId,
      status,
      terminal: status === 'completed' || status === 'cancelled' || status === 'error',
      raw,
      ...(track.events.at(-1) === undefined ? {} : { lastCursor: track.events.at(-1)!.cursor }),
      ...(track.lastTurnEndSeq === undefined ? {} : { lastTurnEndSeq: track.lastTurnEndSeq }),
      ...(track.error === undefined ? {} : { error: track.error }),
    }
  }

  private isCompleted(track: SessionTrack): boolean {
    return track.lastTurnEndSeq !== undefined && track.lastTurnEndSeq > track.completionFloorSeq
  }

  private hasTerminalState(track: SessionTrack): boolean {
    return track.cancelled || track.error !== undefined || this.isCompleted(track)
  }

  private require(sessionId: string): SessionTrack {
    const track = this.sessions.get(sessionId)
    if (track === undefined) throw new BridgeError('SESSION_NOT_TRACKED', `Session "${sessionId}" is not tracked by this bridge instance.`, 404)
    return track
  }
}
