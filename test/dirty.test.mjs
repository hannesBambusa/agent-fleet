// The uncommitted counts the fleet cards carry, against a real repository.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-dirty-'))
const out = join(dir, 'read.cjs')
await build({
  entryPoints: ['src/main/git/read.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { dirtyOf } = await import(`file://${out}`).then((m) => m.default ?? m)

const repo = join(dir, 'repo')
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
mkdirSync(repo)
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'test')
writeFileSync(join(repo, 'a.txt'), 'one\n')
git('add', 'a.txt')
git('commit', '-qm', 'first')

test('a clean checkout has nothing open', async () => {
  assert.deepEqual((await dirtyOf([repo]))[repo], { changed: 0, staged: 0 })
})

test('staged and unstaged are counted apart', async () => {
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  writeFileSync(join(repo, 'b.txt'), 'new\n')
  git('add', 'b.txt')
  const d = (await dirtyOf([repo]))[repo]
  assert.equal(d.staged, 1, 'b.txt is staged')
  assert.equal(d.changed, 1, 'a.txt is changed')
})

test('an untracked file counts as changed', async () => {
  writeFileSync(join(repo, 'c.txt'), 'untracked\n')
  assert.equal((await dirtyOf([repo]))[repo].changed, 2)
})

// The parent checkout sees every agent's worktree as an untracked directory. Counting those makes a
// clean repository report several dirty files and makes the badge meaningless.
test('agent worktrees are not this checkout uncommitted work', async () => {
  mkdirSync(join(repo, '.claude', 'worktrees', 'agent-2'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'worktrees', 'agent-2', 'x.txt'), 'other agent\n')
  const d = (await dirtyOf([repo]))[repo]
  assert.equal(d.changed, 2, 'still just a.txt and c.txt')
})

test('several checkouts in one call, each with its own answer', async () => {
  const res = await dirtyOf([repo, join(dir, 'nowhere')])
  assert.ok(res[repo])
  assert.equal(res[join(dir, 'nowhere')], undefined)
})
