import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import YAML from 'yaml'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
let smokeRoot: string

async function pack(packageDir: string): Promise<Map<string, Buffer>> {
  const destination = await mkdtemp(join(smokeRoot, 'pack-'))
  const pnpm = process.env.npm_execpath
  if (pnpm === undefined) throw new Error('artifact smoke must run from pnpm')
  await run(process.execPath, [pnpm, 'pack', '--pack-destination', destination], { cwd: packageDir })
  const name = (await readdir(destination)).find(entry => entry.endsWith('.tgz'))
  if (name === undefined) throw new Error('pnpm pack produced no tarball')
  const tar = gunzipSync(await readFile(join(destination, name)))
  const files = new Map<string, Buffer>()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const path = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    offset += 512
    files.set(path, tar.subarray(offset, offset + size))
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

async function extract(files: Map<string, Buffer>, target: string): Promise<void> {
  for (const [name, data] of files) {
    if (!name.startsWith('package/') || name.endsWith('/')) continue
    const path = join(target, name.slice('package/'.length))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }
}

beforeAll(async () => {
  smokeRoot = await mkdtemp(join(root, '.pack-smoke-'))
})

afterAll(async () => {
  await rm(smokeRoot, { recursive: true, force: true })
})

describe('packed artifacts', () => {
  it('packs a valid official Desktop bundle with self-contained protocol runtime', async () => {
    const files = await pack(join(root, 'packages/dsh-plugin'))
    const manifest = JSON.parse(files.get('package/package.json')!.toString('utf8')) as Record<string, any>
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.exports['./package.json']).toBe('./package.json')
    expect(manifest.dependencies?.['@dsh-codex-bridge/protocol']).toBeUndefined()
    expect(YAML.parse(files.get('package/cordis.patch.yml')!.toString('utf8'))).toEqual([
      { insert: [{ id: 'codex-bridge', name: '@dsh-codex-bridge/dsh-plugin', inject: ['sessionController', 'workspaceRegistry'] }] },
    ])
    expect(files.get('package/lib/index.js')!.toString('utf8')).not.toContain('@dsh-codex-bridge/protocol')
    const extracted = join(smokeRoot, 'plugin')
    await extract(files, extracted)
    const peerRoot = join(extracted, 'node_modules', '@deepseek-ai')
    await mkdir(peerRoot, { recursive: true })
    const schemastery = await realpath(join(root, 'packages/dsh-plugin/node_modules/@deepseek-ai/schemastery'))
    await symlink(schemastery, join(peerRoot, 'schemastery'), 'dir')
    const loaded = await import(`${new URL(`file://${join(extracted, 'lib/index.js')}`).href}?smoke=${Date.now()}`)
    expect(loaded).toMatchObject({ name: 'codex-bridge', inject: ['sessionController', 'workspaceRegistry'] })
    expect(loaded.default).toBeUndefined()
  })

  it('packs an importable MCP binary without a private protocol dependency', async () => {
    const files = await pack(join(root, 'packages/mcp-server'))
    const manifest = JSON.parse(files.get('package/package.json')!.toString('utf8')) as Record<string, any>
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.bin['dsh-codex-bridge-mcp']).toBe('./lib/bin.js')
    expect(manifest.exports['./package.json']).toBe('./package.json')
    expect(manifest.dependencies?.['@dsh-codex-bridge/protocol']).toBeUndefined()
    expect(files.get('package/lib/index.js')!.toString('utf8')).not.toContain('@dsh-codex-bridge/protocol')
    const extracted = join(smokeRoot, 'mcp')
    await extract(files, extracted)
    const loaded = await import(`${new URL(`file://${join(extracted, 'lib/index.js')}`).href}?smoke=${Date.now()}`)
    expect(typeof loaded.createMcpServer).toBe('function')
  })
})
