import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BridgeError } from '@dsh-codex-bridge/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { BridgeClient } from '../src/client.js'
import { createMcpServer } from '../src/index.js'

describe('BridgeClient', () => {
  it('fails fast with the explicit absent-Host diagnostic', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-missing-'))
    const client = new BridgeClient({ connectionFile: join(directory, 'missing.json') })
    await expect(client.call('/v1/status', { sessionId: 's' })).rejects.toMatchObject({
      code: 'HOST_NOT_RUNNING',
      message: 'DSH Desktop bridge is not running.',
    })
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
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toEqual([
        'dsh_delegate', 'dsh_status', 'dsh_wait', 'dsh_follow', 'dsh_cancel',
      ])
      const response = await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work' } })
      expect(response.structuredContent).toEqual({ sessionId: 'session-1', status: 'queued', guidance: 'Use dsh_wait.' })
      expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(response.structuredContent) }])
      expect(call).toHaveBeenCalledWith('/v1/delegate', { task: 'work', cwd: resolve(process.cwd()) })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('frames the exact missing Host error without writing a protocol error outside MCP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-missing-mcp-'))
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
      const response = await client.callTool({ name: 'dsh_delegate', arguments: { task: 'work' } })
      const expected = { error: { code: 'SESSION_ADMISSION_FAILED', message: 'Session exists.', details: { sessionId: 'session-1' } } }
      expect(response.isError).toBe(true)
      expect(response.structuredContent).toEqual(expected)
      expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
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
