import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BRIDGE_VERSION, BridgeError } from '@dsh-codex-bridge/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient } from '../src/client.js'
import { createMcpServer } from '../src/index.js'

const directories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const connection = {
  endpoint: 'http://127.0.0.1:43127',
  token: 'test-token-'.repeat(4),
  pid: 1,
  version: BRIDGE_VERSION,
  instanceId: 'f2ce13d8-d0a5-4eec-b7ad-6b4966457456',
}

describe('BridgeClient', () => {
  it('fails fast with the explicit absent-Host diagnostic', async () => {
    const directory = await temporaryDirectory('bridge-missing-')
    const client = new BridgeClient({ connectionFile: join(directory, 'missing.json') })
    await expect(client.call('/v1/status', { sessionId: 's' })).rejects.toMatchObject({
      code: 'HOST_NOT_RUNNING',
      message: 'DSH Desktop bridge is not running.',
    })
  })

  it.each(['EACCES', 'EISDIR'])('reports unreadable discovery files for %s', async (code) => {
    const directory = await temporaryDirectory('bridge-unreadable-')
    const path = code === 'EISDIR' ? directory : join(directory, 'connection.json')
    if (code === 'EACCES') {
      await writeFile(path, JSON.stringify(connection))
      await chmod(path, 0)
    }
    try {
      await expect(new BridgeClient({ connectionFile: path }).call('/v1/status', { sessionId: 's' }))
        .rejects.toMatchObject({ code: 'HOST_CONNECTION_UNREADABLE', details: { code } })
    } finally {
      if (code === 'EACCES') await chmod(path, 0o600)
    }
  })

  it.each([
    ['malformed JSON', '{'],
    ['invalid schema', JSON.stringify({ ...connection, token: 'short' })],
    ['non-loopback endpoint', JSON.stringify({ ...connection, endpoint: 'http://example.com:43127' })],
    ['old version with invalid schema', JSON.stringify({ ...connection, version: '0.0.0', token: 'short' })],
    ['old version with non-loopback endpoint', JSON.stringify({ ...connection, version: '0.0.0', endpoint: 'http://example.com:43127' })],
  ])('rejects %s as invalid discovery data', async (_description, value) => {
    const directory = await temporaryDirectory('bridge-invalid-')
    const path = join(directory, 'connection.json')
    await writeFile(path, value)
    const fetch = vi.fn()
    await expect(new BridgeClient({ connectionFile: path, fetch }).call('/v1/status', { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'INVALID_DISCOVERY_FILE' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a version mismatch for otherwise valid discovery data', async () => {
    const directory = await temporaryDirectory('bridge-version-')
    const path = join(directory, 'connection.json')
    await writeFile(path, JSON.stringify({ ...connection, version: '0.0.0' }))
    await expect(new BridgeClient({ connectionFile: path }).call('/v1/status', { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'HOST_VERSION_MISMATCH', details: { expected: BRIDGE_VERSION } })
  })

  it('reports a Host timeout without retrying the request', async () => {
    const directory = await temporaryDirectory('bridge-timeout-')
    const path = join(directory, 'connection.json')
    const received = vi.fn()
    const server = createServer(received)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Expected a loopback server port.')
      await writeFile(path, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${String(address.port)}` }))
      const fetch = vi.fn(globalThis.fetch)
      const client = new BridgeClient({ connectionFile: path, requestTimeoutMs: 100, fetch })
      await expect(client.call('/v1/status', { sessionId: 's' })).rejects.toMatchObject({ code: 'HOST_TIMEOUT' })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(received).toHaveBeenCalledTimes(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})

describe('MCP framing', () => {
  it('lists five tools and returns structured plus text JSON over MCP transport', async () => {
    const call = vi.fn(async () => ({
      sessionId: 'session-1',
      status: 'queued',
      guidance: 'Use dsh_wait.',
    }))
    const bridge = { call } as unknown as BridgeClient
    const server = createMcpServer(bridge)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      expect(client.getServerVersion()).toEqual({ name: 'dsh-codex-bridge', version: BRIDGE_VERSION })
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toEqual([
        'dsh_delegate', 'dsh_status', 'dsh_wait', 'dsh_follow', 'dsh_cancel',
      ])
      const response = await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work', cwd: process.cwd() } })
      expect(response.structuredContent).toEqual({ sessionId: 'session-1', status: 'queued', guidance: 'Use dsh_wait.' })
      expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(response.structuredContent) }])
      expect(call).toHaveBeenCalledWith('/v1/delegate', { task: 'work', cwd: resolve(process.cwd()) })
      await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work', cwd: process.cwd(), model: 'opencodex/dsh-zhipuai/glm-5.3', reasoningEffort: 'max' } })
      expect(call).toHaveBeenLastCalledWith('/v1/delegate', {
        task: 'work', cwd: resolve(process.cwd()), model: 'opencodex/dsh-zhipuai/glm-5.3', reasoningEffort: 'max',
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('requires an absolute task cwd and never redirects it to a configured default', async () => {
    const directory = await temporaryDirectory('bridge-default-workspace-')
    vi.stubEnv('DSH_DEFAULT_WORKSPACE_CWD', directory)
    const call = vi.fn(async () => ({ sessionId: 'session-1', status: 'queued' }))
    const server = createMcpServer({ call } as unknown as BridgeClient)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const missing = await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work' } })
      const relative = await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work', cwd: '.' } })
      expect(missing.isError).toBe(true)
      expect(relative.isError).toBe(true)
      expect(call).not.toHaveBeenCalled()
      await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work', cwd: tmpdir() } })
      expect(call).toHaveBeenLastCalledWith('/v1/delegate', { task: 'work', cwd: resolve(tmpdir()) })
      await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work', cwd: process.cwd(), reasoningEffort: 'max' } })
      expect(call).toHaveBeenLastCalledWith('/v1/delegate', { task: 'work', cwd: resolve(process.cwd()), reasoningEffort: 'max' })
    } finally {
      await client.close()
      await server.close()
      vi.unstubAllEnvs()
    }
  })

  it('frames the exact missing Host error without writing a protocol error outside MCP', async () => {
    const directory = await temporaryDirectory('bridge-missing-mcp-')
    const server = createMcpServer(new BridgeClient({ connectionFile: join(directory, 'missing.json') }))
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const response = await client.callTool({ name: 'dsh_status', arguments: { sessionId: 's' } })
      const expected = { error: { code: 'HOST_NOT_RUNNING', message: 'DSH Desktop bridge is not running.' } }
      expect(response.isError).toBe(true)
      expect(response.structuredContent).toEqual(expected)
      expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('preserves structured bridge failures in text and structuredContent', async () => {
    const bridge = {
      call: vi.fn(async () => {
        throw new BridgeError('SESSION_ADMISSION_FAILED', 'Session exists.', 502, { sessionId: 'session-1' })
      }),
    } as unknown as BridgeClient
    const server = createMcpServer(bridge)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const response = await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work', cwd: process.cwd() } })
      const expected = { error: { code: 'SESSION_ADMISSION_FAILED', message: 'Session exists.', details: { sessionId: 'session-1' } } }
      expect(response.isError).toBe(true)
      expect(response.structuredContent).toEqual(expected)
      expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it.each(['dsh_wait', 'dsh_follow'])('returns complete %s events only in text JSON', async (name) => {
    const status = {
      sessionId: 'session-1', status: 'completed', terminal: true,
      raw: { running: false, agentAvailable: true, blank: false, updatedAt: 12 },
      lastCursor: 'cursor-2', lastTurnEndSeq: 2,
    }
    const response = {
      sessionId: 'session-1', status,
      events: [{ cursor: 'cursor-2', kind: 'dsh-event', durableSeq: 2, eventType: 'turn_end', data: { text: 'complete output', bridgeContentTruncated: true }, time: 12 }],
      nextCursor: 'cursor-2', truncated: true,
      ...(name === 'dsh_wait' ? { timedOut: false } : {}),
    }
    const call = vi.fn(async () => response)
    const server = createMcpServer({ call } as unknown as BridgeClient)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({ name, arguments: { sessionId: 'session-1', cursor: 'cursor-1' } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(response) }])
      if (name === 'dsh_wait') {
        expect(call).toHaveBeenCalledWith('/v1/wait', { sessionId: 'session-1', cursor: 'cursor-1', timeoutMs: 30_000 }, 35_000)
      } else {
        expect(call).toHaveBeenCalledWith('/v1/follow', { sessionId: 'session-1', cursor: 'cursor-1', limit: 100 })
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('retains status data in both text and structuredContent', async () => {
    const response = {
      sessionId: 'session-1', status: 'running', terminal: false,
      raw: { running: true, agentAvailable: true, blank: false, updatedAt: 12 },
      lastCursor: 'cursor-1',
    }
    const server = createMcpServer({ call: vi.fn(async () => response) } as unknown as BridgeClient)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({ name: 'dsh_status', arguments: { sessionId: 'session-1' } })
      expect(result.structuredContent).toEqual(response)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(response) }])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('contains no child process or spawn fallback', async () => {
    const files = [
      new URL('../src/client.ts', import.meta.url),
      new URL('../src/index.ts', import.meta.url),
      new URL('../src/bin.ts', import.meta.url),
      new URL('../../dsh-plugin/src/index.ts', import.meta.url),
      new URL('../../dsh-plugin/src/runtime.ts', import.meta.url),
      new URL('../../dsh-plugin/src/server.ts', import.meta.url),
      new URL('../../dsh-plugin/src/tracker.ts', import.meta.url),
    ]
    const sources = await Promise.all(files.map(file => readFile(file, 'utf8')))
    expect(sources.join('\n')).not.toMatch(/node:child_process|\bspawn\s*\(/)
  })
})
