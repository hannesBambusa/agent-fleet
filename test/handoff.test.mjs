// The prompt a handed-off agent wakes up to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-handoff-'))
const out = join(dir, 'h.cjs')
await build({
  entryPoints: ['src/renderer/src/state/handoff.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { handoffPrompt, handoffAt, INLINE_LIMIT } = await import(`file://${out}`).then((m) => m.default ?? m)

const file = (text) => ({ path: '/repo/docs/handoff.md', text })

test('a short document is pasted in, so the agent can start at once', () => {
  const p = handoffPrompt('build the retur tables', file('# Retur\nthe tables are...'), 'backend')
  assert.match(p, /^build the retur tables/)
  assert.match(p, /handed over from backend \(handoff\.md\)/)
  assert.match(p, /# Retur/)
  assert.match(p, /```/)
})

test('the copy is named whatever the size, so the agent can read it again', () => {
  const short = handoffPrompt('go', file('small'), 'backend')
  const long = handoffPrompt('go', file('x'.repeat(INLINE_LIMIT + 1)), 'backend')
  for (const p of [short, long]) assert.match(p, /\.claude\/handoff\/handoff\.md/)
})

test('the destination is relative, because the worktree name is not known yet', () => {
  assert.equal(handoffAt('/any/where/notes.md'), '.claude/handoff/notes.md')
})

test('a long document is referenced where it will be copied to, not where it came from', () => {
  const p = handoffPrompt('do the thing', file('x'.repeat(INLINE_LIMIT + 1)), 'backend')
  assert.match(p, /\.claude\/handoff\/handoff\.md/)
  assert.ok(!p.includes('/repo/docs/'), 'the source path is somebody else\'s repository')
  assert.ok(!p.includes('```'), 'nothing is pasted')
  assert.ok(p.length < 300, 'the prompt stays small')
})

test('an empty note still gives the agent an instruction', () => {
  const p = handoffPrompt('   ', file('content'), 'connect')
  assert.match(p, /^Pick this up\./)
})

test('the note leads, because it is the task', () => {
  const p = handoffPrompt('migrate first', file('notes'), 'backend')
  assert.equal(p.split('\n')[0], 'migrate first')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
