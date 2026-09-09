// Remembered settings: what survives a restart, and what a stale value does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() {
    return store.size
  },
  key: (i) => [...store.keys()][i]
}
const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-persist-'))
const out = join(dir, 'p.cjs')
await build({
  entryPoints: ['src/renderer/src/state/store.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { readPersisted, writePersisted, forgetAll } = await import(`file://${out}`).then((m) => m.default ?? m)

test('a written value reads back', () => {
  writePersisted('gitTab', 'ship')
  assert.equal(readPersisted('gitTab', 'changes'), 'ship')
})

test('an unset key falls back', () => {
  assert.equal(readPersisted('neverSet', 'changes'), 'changes')
})

test('keys are namespaced, so nothing else on the origin is touched', () => {
  writePersisted('x', 1)
  assert.ok(store.has('agent-fleet.x'))
})

test('a corrupt value falls back instead of throwing', () => {
  store.set('agent-fleet.broken', '{not json')
  assert.equal(readPersisted('broken', 'safe'), 'safe')
})

test('booleans and numbers survive the round trip as themselves', () => {
  writePersisted('open', false)
  writePersisted('width', 320)
  assert.equal(readPersisted('open', true), false)
  assert.equal(readPersisted('width', 0), 320)
})

test('forgetAll clears only this app', () => {
  store.set('someone-else', 'keep me')
  writePersisted('mine', 'go')
  forgetAll()
  assert.equal(store.get('someone-else'), 'keep me')
  assert.equal(readPersisted('mine', null), null)
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
