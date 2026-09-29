import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_BRIDGE_PORT, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT } from '@dsh-codex-bridge/protocol'
import { BridgeRuntime } from './runtime.js'
import { BridgeHttpServer } from './server.js'
import type { BridgeContext } from './types.js'

export const name = 'codex-bridge'
export const inject = ['sessionController', 'workspaceRegistry']

export interface Config {
  readonly port?: number
  readonly connectionFile?: string
  readonly eventLimit?: number
  readonly maxTrackedSessions?: number
}

export const Config: Schema<Config> = Schema.object({
  port: Schema.number().min(0).max(65535).default(DEFAULT_BRIDGE_PORT).description('Loopback TCP port; zero selects an ephemeral port.'),
  connectionFile: Schema.string().description('Absolute discovery file path.'),
  eventLimit: Schema.number().min(16).max(MAX_EVENT_LIMIT).default(DEFAULT_EVENT_LIMIT).description('Retained events per tracked session.'),
  maxTrackedSessions: Schema.number().min(1).max(1000).default(100).description('Maximum sessions retained by this bridge instance.'),
})

export function apply(ctx: Context, config: Config): void {
  const resolved = {
    port: config.port ?? DEFAULT_BRIDGE_PORT,
    eventLimit: config.eventLimit ?? DEFAULT_EVENT_LIMIT,
    maxTrackedSessions: config.maxTrackedSessions ?? 100,
    connectionFile: resolve(config.connectionFile ?? defaultConnectionFile()),
  }
  const bridgeCtx = ctx as BridgeContext
  const runtime = new BridgeRuntime(bridgeCtx, randomUUID(), resolved.eventLimit, resolved.maxTrackedSessions)
  const server = new BridgeHttpServer(runtime, {
    port: resolved.port,
    connectionFile: resolved.connectionFile,
  })
  ctx.on('api-session/status', (sessionId, running) => runtime.tracker.recordHostStatus(sessionId, running))
  ctx.on('api-session/error', (sessionId, message) => runtime.tracker.recordError(sessionId, message))
  ctx.effect(async () => {
    const connection = await server.start()
    ctx.logger.info(`codex-bridge listening on ${connection.endpoint}`)
    return async () => server.stop()
  }, 'codex-bridge.loopback-server')
}

export function defaultConnectionFile(): string {
  const dshHome = process.env.DSH_HOME === undefined
    ? join(homedir(), '.dsh')
    : resolve(process.env.DSH_HOME)
  return join(dshHome, 'run', 'codex-bridge.json')
}

export { BridgeRuntime } from './runtime.js'
export { BridgeHttpServer } from './server.js'
export type { BridgeContext, SessionControllerLike, WorkspaceRegistryLike } from './types.js'
