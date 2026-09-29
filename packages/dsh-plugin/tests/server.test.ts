import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { connectionFileSchema } from '@dsh-codex-bridge/protocol'
import { BridgeHttpServer } from '../src/server.js'
import type { BridgeRuntime } from '../src/runtime.js'

function runtime() {
  return {
    instanceId: crypto.randomUUID(),
    dispose: vi.fn(),
    delegate: vi.fn(),
    status: vi.fn(),
    follow: vi.fn(),
    wait: vi.fn(),
    cancel: vi.fn(),
  } as unknown as BridgeRuntime
}

async function start(bridge = runtime()) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-http-'))
  const connectionFile = join(directory, 'run', 'bridge.json')
  const server = new BridgeHttpServer(bridge, { port: 0, connectionFile, token: 't'.repeat(32) })
  const connection = await server.start()
  return { bridge, connectionFile, server, connection }
}

describe('loopback server', () => {
  it('requires bearer auth, writes mode 0600 discovery, and removes only its file', async () => {
    const h = await start()
    expect(h.connection.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(connectionFileSchema.parse(JSON.parse(await readFile(h.connectionFile, 'utf8')))).toEqual(h.connection)
    expect((await stat(h.connectionFile)).mode & 0o777).toBe(0o600)

    const unauthorized = await fetch(`${h.connection.endpoint}/v1/health`)
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })

    const healthy = await fetch(`${h.connection.endpoint}/v1/health`, { headers: { authorization: `Bearer ${h.connection.token}` } })
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toMatchObject({ ok: true })

    await h.server.stop()
    await expect(readFile(h.connectionFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.bridge.dispose).toHaveBeenCalledOnce()
  })

  it('rejects malformed and oversized request bodies before dispatch', async () => {
    const h = await start()
    const headers = { authorization: `Bearer ${h.connection.token}`, 'content-type': 'application/json' }
    const malformed = await fetch(`${h.connection.endpoint}/v1/status`, { method: 'POST', headers, body: '{' })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_JSON' } })

    const oversized = await fetch(`${h.connection.endpoint}/v1/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: 'x'.repeat(1_048_576) }),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } })
    expect(h.bridge.status).not.toHaveBeenCalled()
    await h.server.stop()
  })

  it('aborts a long wait when the HTTP client disconnects', async () => {
    const bridge = runtime()
    let disconnected!: () => void
    const observed = new Promise<void>(resolve => { disconnected = resolve })
    vi.mocked(bridge.wait).mockImplementation(async (_request, signal) => {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          disconnected()
          reject(signal.reason)
        }, { once: true })
      })
    })
    const h = await start(bridge)
    const url = new URL('/v1/wait', h.connection.endpoint)
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.connection.token}`,
        'content-type': 'application/json',
      },
    })
    request.on('error', () => {})
    request.end(JSON.stringify({ sessionId: 's1', timeoutMs: 60_000 }))
    await vi.waitFor(() => expect(bridge.wait).toHaveBeenCalledOnce())
    request.destroy()
    await expect(observed).resolves.toBeUndefined()
    await h.server.stop()
  })
})
