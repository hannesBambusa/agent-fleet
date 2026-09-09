// The slash menu's list and ranking: what is offered, and in what order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-slash-'))
const out = join(dir, 'slash.cjs')
await build({
  entryPoints: ['src/renderer/src/workspace/slash.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { slashItems, filterSlash, slashQuery } = await import(`file://${out}`).then((m) => m.default ?? m)

const item = (over) => ({
  kind: 'command',
  name: 'x',
  description: '',
  source: 'user',
  origin: 'global',
  path: '/tmp/x.md',
  model: null,
  tools: null,
  hint: null,
  userOnly: false,
  at: null,
  ...over
})

test('the menu opens while the command is still being typed, and not after', () => {
  assert.equal(slashQuery('/'), null, 'a bare slash is not yet a question')
  assert.equal(slashQuery('/c'), 'c')
  assert.equal(slashQuery('/comm'), 'comm')
  assert.equal(slashQuery('/caveman:caveman-commit'), 'caveman:caveman-commit')
  assert.equal(slashQuery('/commit now please'), null, 'arguments close it')
  assert.equal(slashQuery('hello'), null)
})

test('a plugin command is offered under its namespace', () => {
  const list = slashItems([item({ name: 'caveman-commit', source: 'plugin', origin: 'caveman' })])
  assert.ok(list.some((i) => i.token === 'caveman:caveman-commit'))
})

test('skills are typable too, and marked as skills', () => {
  const list = slashItems([item({ kind: 'skill', name: 'graphify' })])
  const found = list.find((i) => i.token === 'graphify')
  assert.equal(found.kind, 'skill')
})

test('built-ins are offered even though no file defines them', () => {
  const list = slashItems([])
  assert.ok(list.some((i) => i.token === 'clear' && i.source === 'built-in'))
})

test('one entry per token when a skill and a command share a name', () => {
  const list = slashItems([item({ name: 'commit' }), item({ kind: 'skill', name: 'commit' })])
  assert.equal(list.filter((i) => i.token === 'commit').length, 1)
})

test('a prefix match ranks above a match in the middle', () => {
  const list = slashItems([item({ name: 'preflight' }), item({ name: 'run-preflight-again' })])
  const hits = filterSlash(list, 'pre')
  assert.equal(hits[0].token, 'preflight')
})

test('an exact name wins outright', () => {
  const list = slashItems([item({ name: 'commit' }), item({ name: 'commit-all' })])
  assert.equal(filterSlash(list, 'commit')[0].token, 'commit')
})

test('a word inside a namespaced token still matches', () => {
  const list = slashItems([item({ name: 'caveman-commit', source: 'plugin', origin: 'caveman' })])
  assert.ok(filterSlash(list, 'commit').length)
})

test('the description is searched when nothing matches the name', () => {
  const list = slashItems([item({ name: 'qa', description: 'Review the staged changes for bugs' })])
  assert.ok(filterSlash(list, 'staged').some((i) => i.token === 'qa'))
})

test('one letter is enough to get a useful list', () => {
  const list = slashItems([item({ name: 'preflight' })])
  const hits = filterSlash(list, 'p')
  assert.equal(hits[0].token, 'preflight', 'own commands rank above built-ins')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
