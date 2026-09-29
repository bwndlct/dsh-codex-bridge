import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BridgeError,
  bridgeErrorBodySchema,
  connectionFileSchema,
  routeResponseSchemas,
  type BridgeRoute,
} from '@dsh-codex-bridge/protocol'

export interface BridgeClientOptions {
  readonly connectionFile?: string
  readonly requestTimeoutMs?: number
  readonly fetch?: typeof fetch
}

export class BridgeClient {
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(private readonly options: BridgeClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
  }

  async call<T>(route: BridgeRoute, body: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const connection = await this.connection()
    try {
      const response = await this.fetchImpl(`${connection.endpoint}${route}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = await this.parseResponse(response)
      if (!response.ok) {
        const failure = bridgeErrorBodySchema.safeParse(payload)
        if (!failure.success) {
          throw new BridgeError('INVALID_HOST_RESPONSE', `DSH Desktop bridge returned malformed HTTP ${String(response.status)} error JSON.`, 502)
        }
        throw new BridgeError(
          failure.data.error.code,
          failure.data.error.message,
          response.status,
          failure.data.error.details,
        )
      }
      const parsed = routeResponseSchemas[route].safeParse(payload)
      if (!parsed.success) {
        throw new BridgeError('INVALID_HOST_RESPONSE', 'DSH Desktop bridge returned an invalid response.', 502, parsed.error.issues)
      }
      return parsed.data as T
    } catch (error) {
      if (error instanceof BridgeError) throw error
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new BridgeError('HOST_TIMEOUT', 'DSH Desktop bridge request timed out.', 504)
      }
      throw new BridgeError('HOST_NOT_RUNNING', 'DSH Desktop bridge is not running.', 503)
    }
  }

  connectionPath(): string {
    if (this.options.connectionFile !== undefined) return resolve(this.options.connectionFile)
    const dshHome = process.env.DSH_HOME === undefined ? join(homedir(), '.dsh') : resolve(process.env.DSH_HOME)
    return join(dshHome, 'run', 'codex-bridge.json')
  }

  private async connection() {
    try {
      return connectionFileSchema.parse(JSON.parse(await readFile(this.connectionPath(), 'utf8')))
    } catch {
      throw new BridgeError('HOST_NOT_RUNNING', 'DSH Desktop bridge is not running.', 503)
    }
  }

  private async parseResponse(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new BridgeError('INVALID_HOST_RESPONSE', 'DSH Desktop bridge returned invalid JSON.', 502)
    }
  }
}
