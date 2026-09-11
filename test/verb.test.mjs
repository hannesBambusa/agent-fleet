// Reading Claude Code's own status word out of its terminal output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-verb-'))
const out = join(dir, 'v.cjs')
await build({
  entryPoints: ['src/renderer/src/state/verbIn.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { verbIn } = await import(`file://${out}`).then((m) => m.default ?? m)

const ESC = String.fromCharCode(27)

test('the word is read from the status line', () => {
  assert.equal(verbIn('✻ Mustering… (12s · ↑ 1.4k tokens)'), 'Mustering')
})

test('escape codes around it do not matter', () => {
  const line = `${ESC}[2K${ESC}[38;5;213m✻${ESC}[0m Pondering… (5s · ↓ 900 tokens)`
  assert.equal(verbIn(line), 'Pondering')
})

test('three dots are as good as an ellipsis', () => {
  assert.equal(verbIn('* Noodling... (1m 2s)'), 'Noodling')
})

test('the newest word wins when a chunk holds several', () => {
  assert.equal(verbIn('✻ Thinking… (1s)\n✻ Mustering… (4s)'), 'Mustering')
})

test('prose is not a status line', () => {
  assert.equal(verbIn('Done. The tests pass now.'), null)
  assert.equal(verbIn('Processing your request'), null, 'no ellipsis, no bracket')
  assert.equal(verbIn(''), null)
})

test('a lowercase word is not the status verb', () => {
  assert.equal(verbIn('running… ('), null)
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
