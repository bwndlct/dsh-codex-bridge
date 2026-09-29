import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  BridgeError,
  type CancelResponse,
  type DelegateRequest,
  type DelegateResponse,
  type FollowRequest,
  type FollowResponse,
  type StatusResponse,
  type WaitRequest,
  type WaitResponse,
} from '@dsh-codex-bridge/protocol'
import { EventTracker } from './tracker.js'
import type { BridgeContext, ModelCatalog } from './types.js'

export class BridgeRuntime {
  readonly tracker: EventTracker

  constructor(
    private readonly ctx: BridgeContext,
    readonly instanceId: string,
    eventLimit: number,
    maxSessions: number,
  ) {
    this.tracker = new EventTracker(ctx.sessionController, instanceId, eventLimit, maxSessions)
  }

  async delegate(request: DelegateRequest, signal: AbortSignal): Promise<DelegateResponse> {
    const task = request.task.trim()
    if (task.length === 0) throw new BridgeError('INVALID_TASK', 'task must be nonempty', 400)
    const cwd = await this.resolveDirectory(request.cwd)
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    const selection = request.model === undefined
      ? undefined
      : { ...this.resolveModel(await this.ctx.sessionController.modelCatalog(), request.model), source: 'override' as const }
    this.tracker.ensureCapacity()
    const created = workspace === undefined
      ? await this.ctx.sessionController.create({ cwd })
      : await this.ctx.sessionController.create({ workspaceId: workspace.id })
    this.tracker.start(created.sessionId)
    try {
      if (selection?.source === 'override') {
        const { provider, model } = selection
        await this.ctx.sessionController.selectModel({ sessionId: created.sessionId, provider, model })
      }
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: task }],
      }, signal)
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      this.tracker.recordError(created.sessionId, cause)
      throw new BridgeError(
        'SESSION_ADMISSION_FAILED',
        'A DSH Host session was created, but model selection or prompt admission failed.',
        502,
        { sessionId: created.sessionId, cause },
      )
    }
    return {
      sessionId: created.sessionId,
      status: 'queued',
      cwd,
      workspace: {
        matched: workspace !== undefined,
        ...(workspace === undefined ? {} : { id: workspace.id }),
      },
      ...(selection === undefined ? {} : { model: selection }),
      guidance: 'Prompt admitted. Use dsh_wait for bounded waiting, dsh_status for current Host state, or dsh_follow for incremental events.',
    }
  }

  status(sessionId: string, signal: AbortSignal): Promise<StatusResponse> {
    return this.tracker.status(sessionId, signal)
  }

  follow(request: FollowRequest, signal: AbortSignal): Promise<FollowResponse> {
    return this.tracker.follow(request.sessionId, request.cursor, request.limit ?? 100, signal)
  }

  async wait(request: WaitRequest, signal: AbortSignal): Promise<WaitResponse> {
    const result = await this.tracker.wait(request.sessionId, request.cursor, request.timeoutMs ?? 30_000, signal)
    return {
      sessionId: request.sessionId,
      timedOut: result.timedOut,
      status: result.follow.status,
      events: result.follow.events,
      ...(result.follow.nextCursor === undefined ? {} : { nextCursor: result.follow.nextCursor }),
      truncated: result.follow.truncated,
    }
  }

  async cancel(sessionId: string): Promise<CancelResponse> {
    this.tracker.assertTracked(sessionId)
    const dsh = await this.ctx.sessionController.cancel({ sessionId })
    this.tracker.recordCancelled(sessionId)
    return {
      sessionId,
      bridgeAccepted: true,
      dsh,
      status: 'cancelled',
      message: 'Cancellation was admitted for the active turn; the DSH session is retained.',
    }
  }

  dispose(): void {
    this.tracker.stopAll()
  }

  private async resolveDirectory(input: string): Promise<string> {
    const absolute = resolve(input)
    let canonical: string
    try {
      canonical = await realpath(absolute)
    } catch (error) {
      throw new BridgeError('INVALID_CWD', `cwd does not resolve: ${absolute}`, 400, this.fsCode(error))
    }
    let details
    try {
      details = await stat(canonical)
    } catch (error) {
      throw new BridgeError('INVALID_CWD', `cwd cannot be inspected: ${canonical}`, 400, this.fsCode(error))
    }
    if (!details.isDirectory()) throw new BridgeError('INVALID_CWD', `cwd is not a directory: ${canonical}`, 400)
    return canonical
  }

  private resolveModel(catalog: ModelCatalog, value: string): { readonly provider: string; readonly model: string } {
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) {
      throw new BridgeError('INVALID_MODEL', 'model must use exact provider/model syntax', 400)
    }
    const provider = value.slice(0, slash)
    const model = value.slice(slash + 1)
    const group = catalog.groups.find(candidate => candidate.id === provider)
    if (group === undefined || !group.models.some(candidate => candidate.id === model)) {
      throw new BridgeError('MODEL_NOT_FOUND', `Model "${value}" is not an exact available catalog entry.`, 400, {
        available: catalog.groups.flatMap(candidate => candidate.models.map(entry => `${candidate.id}/${entry.id}`)),
      })
    }
    return { provider, model }
  }

  private fsCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  }
}
