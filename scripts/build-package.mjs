import { execFile } from 'node:child_process'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const run = promisify(execFile)

const target = process.argv[2]
if (target !== 'plugin' && target !== 'mcp') throw new Error('usage: build-package.mjs plugin|mcp')

const root = resolve(import.meta.dirname, '..')
const packageDir = resolve(root, 'packages', target === 'plugin' ? 'dsh-plugin' : 'mcp-server')
const outdir = resolve(packageDir, 'lib')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const pnpm = process.env.npm_execpath
if (pnpm === undefined) throw new Error('build-package.mjs must run from pnpm')
await run(process.execPath, [pnpm, 'exec', 'tsc', '-p', resolve(packageDir, 'tsconfig.json'), '--emitDeclarationOnly'], {
  cwd: packageDir,
})

if (target === 'plugin') {
  await build({
    entryPoints: [resolve(packageDir, 'src/index.ts')],
    outfile: resolve(outdir, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    external: ['@deepseek-ai/*'],
  })
} else {
  await build({
    entryPoints: {
      index: resolve(packageDir, 'src/index.ts'),
      bin: resolve(packageDir, 'src/bin.ts'),
    },
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
  })
  await chmod(resolve(outdir, 'bin.js'), 0o755)
}
