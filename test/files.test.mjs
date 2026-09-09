// Path detection in chat text, and the guard on what the viewer may read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-files-'))
const paths = join(dir, 'p.cjs')
const browse = join(dir, 'b.cjs')
await build({
  entryPoints: ['src/renderer/src/state/openFile.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: paths,
  logLevel: 'error'
})
await build({
  entryPoints: ['src/main/files/browse.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: browse,
  logLevel: 'error'
})
const { splitPaths, resolvePath } = await import(`file://${paths}`).then((m) => m.default ?? m)
const { allow } = await import(`file://${browse}`).then((m) => m.default ?? m)

const found = (s) => splitPaths(s).filter((p) => p.path).map((p) => p.text)

test('a path mentioned mid-sentence is picked out', () => {
  assert.deepEqual(
    found('Done. docs/hivemind-retur-tables-handoff.md — hand that one to the coder.'),
    ['docs/hivemind-retur-tables-handoff.md']
  )
})

test('absolute, relative and home paths all count', () => {
  assert.deepEqual(found('see /Users/x/repo/a.ts'), ['/Users/x/repo/a.ts'])
  assert.deepEqual(found('run ./scripts/build.sh now'), ['./scripts/build.sh'])
  assert.deepEqual(found('edit ~/.claude/settings.json'), ['~/.claude/settings.json'])
})

test('several in one line are all found, and the prose between is kept', () => {
  const pieces = splitPaths('moved src/a.ts to src/b.ts')
  assert.deepEqual(pieces.map((p) => p.text), ['moved ', 'src/a.ts', ' to ', 'src/b.ts'])
})

test('a url is left alone, wherever the match falls inside it', () => {
  assert.deepEqual(found('open https://example.com/docs/thing.html'), [])
  assert.deepEqual(found('see http://localhost:3013/src/app.js for the served copy'), [])
  assert.deepEqual(found('git@github.com:owner/repo.git'), [])
})

test('prose is not mistaken for a path', () => {
  assert.deepEqual(found('the build passed and the tests are green'), [])
  assert.deepEqual(found('roughly 3.5 seconds'), [])
  assert.deepEqual(found('done'), [])
})

test('a bare filename with no folder is not a link', () => {
  // too easy to hit a sentence like "see index.ts" that names nothing openable
  assert.deepEqual(found('check index.ts'), [])
})

test('relative paths resolve against the session directory', () => {
  assert.equal(resolvePath('docs/a.md', '/repo'), '/repo/docs/a.md')
  assert.equal(resolvePath('./docs/a.md', '/repo/'), '/repo/docs/a.md')
  assert.equal(resolvePath('/abs/a.md', '/repo'), '/abs/a.md')
  assert.equal(resolvePath('~/x.md', '/repo', '/Users/me'), '/Users/me/x.md')
})

test('the viewer only reads inside the roots it was given', () => {
  assert.ok(allow(['/repo'], '/repo/src/a.ts'), 'inside a root is fine')
  assert.ok(allow(['/repo'], join(homedir(), '.claude', 'settings.json')), 'claude config is always readable')
  assert.equal(allow(['/repo'], '/etc/passwd'), null)
  assert.equal(allow(['/repo'], '/repo/../secrets.txt'), null, 'traversal is resolved before the check')
  assert.equal(allow(['/repo'], '/repository/other.ts'), null, 'a prefix is not a parent')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
