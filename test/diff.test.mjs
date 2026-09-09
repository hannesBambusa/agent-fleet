// The line diff behind the edit preview in the chat.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-diff-'))
const out = join(dir, 'diff.cjs')
await build({
  entryPoints: ['src/renderer/src/lib/lineDiff.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { lineDiff, collapse, annotate, summarise } = await import(`file://${out}`).then((m) => m.default ?? m)

const kinds = (rows) => rows.map((r) => r.kind).join('')

test('an unchanged block is all context', () => {
  assert.equal(kinds(lineDiff('a\nb\nc', 'a\nb\nc')), 'contextcontextcontext')
})

test('a changed line keeps its neighbours as anchors', () => {
  const rows = lineDiff('a\nb\nc', 'a\nB\nc')
  assert.equal(rows[0].kind, 'context')
  assert.equal(rows[rows.length - 1].kind, 'context')
  assert.deepEqual(
    rows.filter((r) => r.kind !== 'context').map((r) => `${r.kind}:${r.text}`),
    ['del:b', 'add:B']
  )
})

test('a new file is all additions', () => {
  assert.equal(kinds(lineDiff('', 'x\ny')), 'addadd')
})

test('a deleted block is all removals', () => {
  assert.equal(kinds(lineDiff('x\ny', '')), 'deldel')
})

test('an inserted line does not rewrite the lines around it', () => {
  const rows = lineDiff('a\nc', 'a\nb\nc')
  assert.equal(kinds(rows), 'contextaddcontext')
})

test('collapse keeps context around a change and folds the rest', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const after = before.replace('line 15', 'CHANGED')
  const rows = collapse(lineDiff(before, after), 2)
  assert.ok(rows.length < 12, `folded to ${rows.length} rows`)
  assert.ok(rows.some((r) => r.text.includes('unchanged line')), 'says what it hid')
  assert.ok(rows.some((r) => r.kind === 'add' && r.text === 'CHANGED'))
})


// ---- numbering and word marks ----------------------------------------------
test('rows are numbered from where the edit lands', () => {
  const rows = annotate(lineDiff('a\nb\nc', 'a\nB\nc'), 102)
  assert.deepEqual(rows.map((r) => [r.kind, r.n]), [
    ['context', 102],
    ['del', 103],
    ['add', 103],
    ['context', 104]
  ])
})

test('an insertion shifts the numbers below it in the new file', () => {
  const rows = annotate(lineDiff('a\nc', 'a\nb\nc'), 10)
  assert.deepEqual(rows.map((r) => [r.kind, r.n]), [
    ['context', 10],
    ['add', 11],
    ['context', 12]
  ])
})

test('only the words that changed are marked', () => {
  const rows = annotate(lineDiff('this.setDepth(2)', 'this.setDepth(6)'))
  const del = rows.find((r) => r.kind === 'del')
  const add = rows.find((r) => r.kind === 'add')
  assert.deepEqual(del.parts.filter((p) => p.changed).map((p) => p.text), ['2'])
  assert.deepEqual(add.parts.filter((p) => p.changed).map((p) => p.text), ['6'])
  assert.ok(del.parts.some((p) => !p.changed && p.text.includes('setDepth')))
})

test('a line with nothing in common is left unmarked', () => {
  const rows = annotate(lineDiff('aaa', 'zzz'))
  assert.equal(rows.find((r) => r.kind === 'del').parts, undefined)
})

test('the summary reads the way Claude Code words it', () => {
  assert.equal(summarise(lineDiff('a', 'a\nb')), 'Added 1 line')
  assert.equal(summarise(lineDiff('a\nb\nc', 'a\nB\nc')), 'Added 1 line, removed 1')
  assert.equal(summarise(lineDiff('a\nb', 'a')), 'Removed 1 line')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
