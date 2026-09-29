import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import {
  BRIDGE_VERSION,
  BridgeError,
  connectionFileSchema,
  delegateRequestSchema,
  followRequestSchema,
  routeSchemas,
  sessionRequestSchema,
  waitRequestSchema,
  type BridgeRoute,
  type ConnectionFile,
} from '@dsh-codex-bridge/protocol'
import { ZodError } from 'zod'
import type { BridgeRuntime } from './runtime.js'

const MAX_BODY_BYTES = 1_048_576

export interface BridgeServerOptions {
  readonly port: number
  readonly connectionFile: string
  readonly token?: string
}

export class BridgeHttpServer {
  private server: Server | undefined
  private connection?: ConnectionFile

  constructor(private readonly runtime: BridgeRuntime, private readonly options: BridgeServerOptions) {}

  async start(): Promise<ConnectionFile> {
    if (this.server !== undefined) throw new Error('bridge server is already started')
    const token = this.options.token ?? randomBytes(32).toString('base64url')
    if (token.length < 32) throw new Error('bridge token must contain at least 32 characters')
    const server = createServer((request, response) => { void this.handle(request, response, token) })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => reject(error)
        server.once('error', failed)
        server.listen(this.options.port, '127.0.0.1', () => {
          server.off('error', failed)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('bridge server has no TCP address')
      const connection = connectionFileSchema.parse({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        token,
        pid: process.pid,
        version: BRIDGE_VERSION,
        instanceId: this.runtime.instanceId,
      })
      await this.writeConnection(connection)
      this.connection = connection
      return connection
    } catch (error) {
      await this.closeServer()
      throw new Error(`codex-bridge failed to bind or publish discovery: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stop(): Promise<void> {
    this.runtime.dispose()
    await this.closeServer()
    await this.removeOwnedConnection()
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(new Error('HTTP request aborted'))
    const requestClosed = (): void => {
      if (!request.complete) abort()
    }
    const responseClosed = (): void => {
      if (!response.writableEnded) abort()
    }
    request.once('aborted', abort)
    request.once('close', requestClosed)
    response.once('close', responseClosed)
    try {
      if (!this.authorized(request.headers.authorization, token)) throw new BridgeError('UNAUTHORIZED', 'Bearer token is missing or invalid.', 401)
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (request.method === 'GET' && path === '/v1/health') {
        this.json(response, 200, { ok: true, version: BRIDGE_VERSION, pid: process.pid })
        return
      }
      if (request.method !== 'POST' || !(path in routeSchemas)) throw new BridgeError('NOT_FOUND', 'Endpoint not found.', 404)
      const body = await this.readJson(request)
      controller.signal.throwIfAborted()
      const result = await this.dispatch(path as BridgeRoute, body, controller.signal)
      this.json(response, 200, result)
    } catch (error) {
      if (response.destroyed) return
      if (error instanceof BridgeError) this.json(response, error.status, error.toJSON())
      else if (error instanceof ZodError) this.json(response, 400, new BridgeError('INVALID_REQUEST', 'Request validation failed.', 400, error.issues).toJSON())
      else this.json(response, 500, new BridgeError('INTERNAL_ERROR', 'Bridge request failed.', 500).toJSON())
    } finally {
      request.off('aborted', abort)
      request.off('close', requestClosed)
      response.off('close', responseClosed)
    }
  }

  private async dispatch(path: BridgeRoute, body: unknown, signal: AbortSignal): Promise<unknown> {
    switch (path) {
      case '/v1/delegate': return this.runtime.delegate(delegateRequestSchema.parse(body), signal)
      case '/v1/status': return this.runtime.status(sessionRequestSchema.parse(body).sessionId, signal)
      case '/v1/follow': return this.runtime.follow(followRequestSchema.parse(body), signal)
      case '/v1/wait': return this.runtime.wait(waitRequestSchema.parse(body), signal)
      case '/v1/cancel': return this.runtime.cancel(sessionRequestSchema.parse(body).sessionId)
    }
  }

  private authorized(header: string | undefined, expected: string): boolean {
    if (header === undefined || !header.startsWith('Bearer ')) return false
    const supplied = header.slice(7)
    const suppliedDigest = createHash('sha256').update(supplied).digest()
    const expectedDigest = createHash('sha256').update(expected).digest()
    return timingSafeEqual(suppliedDigest, expectedDigest)
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new BridgeError('REQUEST_TOO_LARGE', 'Request body exceeds 1 MiB.', 413)
      chunks.push(buffer)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new BridgeError('INVALID_JSON', 'Request body must be valid JSON.', 400)
    }
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  }

  private async writeConnection(connection: ConnectionFile): Promise<void> {
    const target = this.options.connectionFile
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${this.runtime.instanceId}.tmp`
    await writeFile(temporary, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
    await chmod(target, 0o600)
  }

  private async removeOwnedConnection(): Promise<void> {
    const owned = this.connection
    if (owned === undefined) return
    try {
      const current = connectionFileSchema.parse(JSON.parse(await readFile(this.options.connectionFile, 'utf8')))
      if (current.instanceId === owned.instanceId) await rm(this.options.connectionFile, { force: true })
    } catch {
      // Missing, replaced, or malformed discovery is not owned by this instance.
    }
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
