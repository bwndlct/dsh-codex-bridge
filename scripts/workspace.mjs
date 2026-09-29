import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pnpm = process.env.npm_execpath
if (pnpm === undefined) throw new Error('workspace.mjs must run from pnpm')

async function run(args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else reject(new Error(`pnpm ${args.join(' ')} failed (${signal ?? String(code)})`))
    })
  })
}

const command = process.argv[2]
if (command === 'check') {
  await run(['run', 'build'])
  await run(['run', 'lint'])
  await run(['run', 'test'])
} else if (command === 'pack') {
  const target = process.argv[3]
  const names = {
    protocol: '@dsh-codex-bridge/protocol',
    plugin: '@dsh-codex-bridge/dsh-plugin',
    mcp: '@dsh-codex-bridge/mcp-server',
  }
  const name = names[target]
  if (name === undefined) throw new Error('usage: workspace.mjs pack protocol|plugin|mcp')
  await mkdir(resolve(root, 'dist'), { recursive: true })
  await run(['--filter', name, 'pack', '--pack-destination', resolve(root, 'dist')])
} else {
  throw new Error('usage: workspace.mjs check|pack')
}
