// Lane assignment for the commit graph. Pure, and the failure mode is subtle: a graph that draws
// but shows a merge as an unrelated parallel line, or a branch that never rejoins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-graph-'))
const out = join(dir, 'graph.cjs')
await build({
  entryPoints: ['src/renderer/src/git/graph.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { layout, refBadges } = await import(`file://${out}`).then((m) => m.default ?? m)

const c = (sha, parents, refs = []) => ({ sha, parents, refs, subject: sha, at: '', author: '' })

test('a straight history uses one lane', () => {
  const { rows, width } = layout([c('c', ['b']), c('b', ['a']), c('a', [])])
  assert.equal(width, 1)
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0])
  assert.equal(rows[0].down, true)
  assert.equal(rows[0].up, false, 'the newest commit has nothing above it')
  assert.equal(rows[2].down, false, 'the root commit has no parent to continue to')
})

test('a merge opens a second lane and the branch rejoins it', () => {
  //  m ── merge of main (a) and a side branch (s)
  const { rows, width } = layout([c('m', ['a', 's']), c('a', ['r']), c('s', ['r']), c('r', [])])
  assert.equal(width, 2)
  assert.equal(rows[0].lane, 0)
  assert.equal(rows[1].lane, 0, 'the first parent keeps the merge commit lane')
  assert.equal(rows[2].lane, 1, 'the second parent gets a lane of its own')
  // the merge row draws a line leaving for the new lane
  assert.ok(rows[0].links.some((l) => l.from === 0 && l.to === 1))
  // and the shared root collapses both lanes back together
  assert.ok(rows[3].links.some((l) => l.from === 1 && l.to === 0))
})

test('an unrelated lane passing a row is drawn straight through', () => {
  const { rows } = layout([c('m', ['a', 's']), c('a', ['r']), c('s', ['r']), c('r', [])])
  const through = rows[1].links.find((l) => l.straight)
  assert.ok(through, 'the side branch continues past the row it does not own')
  assert.equal(through.from, 1)
  assert.equal(through.to, 1)
})

test('lanes free up again so the graph does not grow forever', () => {
  const { width } = layout([
    c('m2', ['m1', 'y']),
    c('m1', ['a', 'x']),
    c('a', ['r']),
    c('x', ['r']),
    c('y', ['r']),
    c('r', [])
  ])
  assert.ok(width <= 3, `three concurrent lanes at most, got ${width}`)
})

test('a commit with no parents ends its lane', () => {
  const { rows } = layout([c('a', [])])
  assert.equal(rows[0].down, false)
})

test('refs are labelled by kind, with the checked-out branch first', () => {
  const b = refBadges(['origin/main', 'HEAD -> main', 'tag: v1'])
  assert.equal(b[0].kind, 'head')
  assert.equal(b[0].label, 'main')
  assert.ok(b.some((x) => x.kind === 'remote' && x.label === 'origin/main'))
  assert.ok(b.some((x) => x.kind === 'tag' && x.label === 'v1'))
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
