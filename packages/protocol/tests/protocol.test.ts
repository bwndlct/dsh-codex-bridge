import { describe, expect, it } from 'vitest'
import {
  BRIDGE_VERSION,
  connectionFileSchema,
  delegateRequestSchema,
  followRequestSchema,
  waitRequestSchema,
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

  it('only accepts loopback discovery endpoints', () => {
    const common = { token: 'x'.repeat(32), pid: 1, version: BRIDGE_VERSION, instanceId: crypto.randomUUID() }
    expect(connectionFileSchema.parse({ ...common, endpoint: 'http://127.0.0.1:43127' }).endpoint).toContain('127.0.0.1')
    expect(connectionFileSchema.safeParse({ ...common, version: '0.1.0', endpoint: 'http://127.0.0.1:43127' }).success).toBe(false)
    expect(() => connectionFileSchema.parse({ ...common, endpoint: 'http://localhost:43127' })).toThrow(/127\.0\.0\.1/)
  })
})
