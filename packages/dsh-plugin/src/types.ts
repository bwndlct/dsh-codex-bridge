import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'api-session/status'(sessionId: string, running: boolean): void
    'api-session/error'(sessionId: string, message: string): void
  }
}

export interface SessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly agentAvailable: boolean
  readonly blank: boolean
}

export interface ModelCatalog {
  readonly default?: {
    readonly provider: string
    readonly model: string
  }
  readonly groups: readonly {
    readonly id: string
    readonly models: readonly { readonly id: string; readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] } }[]
  }[]
}

export type FollowFrame =
  | {
    readonly type: 'snapshot'
    readonly cursor: number
    readonly records: readonly { readonly type: 'event'; readonly event: WireEvent }[]
  }
  | { readonly type: 'event'; readonly event: WireEvent }
  | { readonly type: 'assistant-stream'; readonly frame: unknown }

export interface WireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

export interface SessionControllerLike {
  create(request: { readonly workspaceId?: string; readonly cwd?: string }): Promise<{ readonly sessionId: string }>
  modelCatalog(): Promise<ModelCatalog>
  selectModel(request: { readonly sessionId: string; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<unknown>
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue'
    readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  }, signal: AbortSignal): Promise<{ readonly accepted: true }>
  list(request: Record<string, never>, signal: AbortSignal): Promise<{ readonly items: readonly SessionSummary[] }>
  follow(request: {
    readonly address: { readonly kind: 'session'; readonly sessionId: string }
    readonly assistantStream: true
  }, signal: AbortSignal): AsyncIterable<FollowFrame>
  cancel(request: { readonly sessionId: string }): Promise<{ readonly accepted: true }> | { readonly accepted: true }
}

export interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<{ readonly id: string; readonly path?: string } | undefined>
  create(path: string): Promise<{ readonly id: string; readonly path: string }>
}

export interface BridgeContext extends Context {
  readonly sessionController: SessionControllerLike
  readonly workspaceRegistry: WorkspaceRegistryLike
}
