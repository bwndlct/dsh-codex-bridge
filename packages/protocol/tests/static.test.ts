import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const published = [
  'README.md',
  'AGENTS.md',
  'packages/dsh-plugin/README.md',
  'packages/dsh-plugin/package.json',
  'packages/dsh-plugin/src/index.ts',
  'packages/dsh-plugin/src/runtime.ts',
  'packages/dsh-plugin/src/server.ts',
  'packages/dsh-plugin/src/tracker.ts',
  'packages/mcp-server/README.md',
  'packages/mcp-server/package.json',
  'packages/mcp-server/src/bin.ts',
  'packages/mcp-server/src/client.ts',
  'packages/mcp-server/src/index.ts',
]

describe('published Desktop-only surface', () => {
  it('contains no process-launch imports or unsupported runtime instructions', async () => {
    const text = (await Promise.all(published.map(path => readFile(resolve(root, path), 'utf8')))).join('\n')
    const forbidden = [
      ['node:', 'child_', 'process'].join(''),
      ['--', 'profile'].join(''),
      ['dsh', ' web'].join(''),
      ['community', ' Desktop'].join(''),
      ['head', 'less'].join(''),
      ['Desktop', '/Web'].join(''),
      ['Desktop', ' and Web'].join(''),
    ]
    for (const value of forbidden) expect(text.toLowerCase()).not.toContain(value.toLowerCase())
  })
})
