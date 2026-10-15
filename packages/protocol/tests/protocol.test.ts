import { describe, expect, it } from 'vitest'
import {
  BRIDGE_VERSION,
  bridgeContentChunkSchema,
  connectionFileSchema,
  delegateRequestSchema,
  followRequestSchema,
  followResponseSchema,
  waitRequestSchema,
  waitResponseSchema,
} from '../src/index.js'

describe('protocol validation', () => {
  it('rejects empty tasks and unknown fields', () => {
    expect(() => delegateRequestSchema.parse({ task: '   ', cwd: '/tmp' })).toThrow(/nonempty/)
    expect(() => delegateRequestSchema.parse({ task: 'work', cwd: '/tmp', shell: 'rm -rf /' })).toThrow()
  })

  it('bounds follow and wait requests', () => {
    expect(() => followRequestSchema.parse({ sessionId: 's', limit: 501 })).toThrow()
    expect(() => waitRequestSchema.parse({ sessionId: 's', timeoutMs: 120_001 })).toThrow()
    expect(waitRequestSchema.parse({ sessionId: 's' }).timeoutMs).toBe(30_000)
  })

  it('requires page continuation state and validates content chunks', () => {
    const status = {
      sessionId: 's',
      status: 'completed' as const,
      terminal: true,
      raw: { running: false, agentAvailable: true, blank: false, updatedAt: 12 },
    }
    expect(() => followResponseSchema.parse({ sessionId: 's', events: [], truncated: false, status })).toThrow()
    expect(() => waitResponseSchema.parse({ sessionId: 's', timedOut: false, events: [], truncated: false, status })).toThrow()
    expect(followResponseSchema.parse({ sessionId: 's', events: [], hasMore: false, truncated: false, status }).hasMore).toBe(false)
    expect(waitResponseSchema.parse({ sessionId: 's', timedOut: false, events: [], hasMore: true, truncated: false, status }).hasMore).toBe(true)

    const chunk = bridgeContentChunkSchema.parse({
      bridgeContentChunk: true,
      id: 'cursor-1',
      index: 0,
      total: 2,
      encoding: 'json',
      text: '{"text":"complete ',
    })
    expect(chunk.index).toBe(0)
    expect(() => bridgeContentChunkSchema.parse({ ...chunk, index: 2 })).toThrow(/less than total/)
    expect(() => bridgeContentChunkSchema.parse({ ...chunk, index: -1 })).toThrow()
    expect(() => bridgeContentChunkSchema.parse({ ...chunk, index: 0.5 })).toThrow()
    expect(() => bridgeContentChunkSchema.parse({ ...chunk, total: 0 })).toThrow()
    expect(() => bridgeContentChunkSchema.parse({ ...chunk, id: '' })).toThrow()
    expect(() => bridgeContentChunkSchema.parse({ ...chunk, encoding: 'json-utf8' })).toThrow()
  })

  it('only accepts loopback discovery endpoints', () => {
    const common = { token: 'x'.repeat(32), pid: 1, version: BRIDGE_VERSION, instanceId: crypto.randomUUID() }
    expect(connectionFileSchema.parse({ ...common, endpoint: 'http://127.0.0.1:43127' }).endpoint).toContain('127.0.0.1')
    expect(connectionFileSchema.safeParse({ ...common, version: '0.1.0', endpoint: 'http://127.0.0.1:43127' }).success).toBe(false)
    expect(() => connectionFileSchema.parse({ ...common, endpoint: 'http://localhost:43127' })).toThrow(/127\.0\.0\.1/)
  })
})
