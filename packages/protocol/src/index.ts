import { z } from 'zod'

export const BRIDGE_VERSION = '0.2.1'
export const DEFAULT_BRIDGE_PORT = 43127
export const DEFAULT_EVENT_LIMIT = 512
export const MAX_EVENT_LIMIT = 4096
export const MAX_WAIT_MS = 120_000

export const bridgeStatusSchema = z.enum([
  'queued',
  'running',
  'idle',
  'completed',
  'cancelled',
  'error',
])
export type BridgeStatus = z.infer<typeof bridgeStatusSchema>

export const delegateRequestSchema = z.object({
  task: z.string().trim().min(1, 'task must be nonempty'),
  cwd: z.string().min(1),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
}).strict()
export type DelegateRequest = z.infer<typeof delegateRequestSchema>

export const sessionRequestSchema = z.object({ sessionId: z.string().min(1) }).strict()
export type SessionRequest = z.infer<typeof sessionRequestSchema>

export const followRequestSchema = sessionRequestSchema.extend({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()
export type FollowRequest = z.input<typeof followRequestSchema>

export const waitRequestSchema = sessionRequestSchema.extend({
  timeoutMs: z.number().int().min(0).max(MAX_WAIT_MS).default(30_000),
  cursor: z.string().min(1).optional(),
}).strict()
export type WaitRequest = z.input<typeof waitRequestSchema>

export const rawDshStateSchema = z.object({
  running: z.boolean(),
  agentAvailable: z.boolean(),
  blank: z.boolean(),
  updatedAt: z.number(),
}).strict()
export type RawDshState = z.infer<typeof rawDshStateSchema>

export const trackedEventSchema = z.object({
  cursor: z.string(),
  kind: z.enum(['dsh-event', 'assistant-stream', 'status', 'error', 'cancelled']),
  durableSeq: z.number().int().nonnegative().optional(),
  eventType: z.string().optional(),
  data: z.unknown().optional(),
  time: z.number(),
}).strict()
export type TrackedEvent = z.infer<typeof trackedEventSchema>

export const statusResponseSchema = z.object({
  sessionId: z.string(),
  status: bridgeStatusSchema,
  terminal: z.boolean(),
  raw: rawDshStateSchema,
  lastCursor: z.string().optional(),
  lastTurnEndSeq: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}).strict().superRefine((value, context) => {
  const terminal = value.status === 'completed' || value.status === 'cancelled' || value.status === 'error'
  if (value.terminal !== terminal) context.addIssue({ code: 'custom', message: 'terminal must match status' })
})
export type StatusResponse = z.infer<typeof statusResponseSchema>

export const delegateResponseSchema = z.object({
  sessionId: z.string(),
  status: bridgeStatusSchema,
  cwd: z.string(),
  workspace: z.object({
    matched: z.boolean(),
    id: z.string().optional(),
  }).strict(),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
    source: z.enum(['default', 'override']),
  }).strict().optional(),
  guidance: z.string(),
}).strict()
export type DelegateResponse = z.infer<typeof delegateResponseSchema>

export const followResponseSchema = z.object({
  sessionId: z.string(),
  events: z.array(trackedEventSchema),
  nextCursor: z.string().optional(),
  truncated: z.boolean(),
  status: statusResponseSchema,
}).strict()
export type FollowResponse = z.infer<typeof followResponseSchema>

export const waitResponseSchema = z.object({
  sessionId: z.string(),
  timedOut: z.boolean(),
  status: statusResponseSchema,
  events: z.array(trackedEventSchema),
  nextCursor: z.string().optional(),
  truncated: z.boolean(),
}).strict()
export type WaitResponse = z.infer<typeof waitResponseSchema>

export const cancelResponseSchema = z.object({
  sessionId: z.string(),
  bridgeAccepted: z.literal(true),
  dsh: z.object({ accepted: z.literal(true) }).strict(),
  status: bridgeStatusSchema,
  message: z.string(),
}).strict()
export type CancelResponse = z.infer<typeof cancelResponseSchema>

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  pid: z.number().int().positive(),
}).strict()

export const connectionFileSchema = z.object({
  endpoint: z.string().url().superRefine((value, context) => {
    const url = new URL(value)
    if (url.protocol !== 'http:') context.addIssue({ code: 'custom', message: 'endpoint must use http' })
    if (url.hostname !== '127.0.0.1') context.addIssue({ code: 'custom', message: 'endpoint must use 127.0.0.1' })
    if (url.port === '') context.addIssue({ code: 'custom', message: 'endpoint must include a port' })
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint must be an origin without credentials, path, query, or fragment' })
    }
  }),
  token: z.string().min(32),
  pid: z.number().int().positive(),
  version: z.literal(BRIDGE_VERSION),
  instanceId: z.string().uuid(),
}).strict()
export type ConnectionFile = z.infer<typeof connectionFileSchema>

export interface BridgeErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details?: unknown
  }
}

export const bridgeErrorBodySchema: z.ZodType<BridgeErrorBody> = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }).strict(),
}).strict()

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'BridgeError'
  }

  toJSON(): BridgeErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    }
  }
}

export const routeSchemas = {
  '/v1/delegate': delegateRequestSchema,
  '/v1/status': sessionRequestSchema,
  '/v1/follow': followRequestSchema,
  '/v1/wait': waitRequestSchema,
  '/v1/cancel': sessionRequestSchema,
} as const

export type BridgeRoute = keyof typeof routeSchemas

export const routeResponseSchemas = {
  '/v1/delegate': delegateResponseSchema,
  '/v1/status': statusResponseSchema,
  '/v1/follow': followResponseSchema,
  '/v1/wait': waitResponseSchema,
  '/v1/cancel': cancelResponseSchema,
} as const satisfies Record<BridgeRoute, z.ZodType>
