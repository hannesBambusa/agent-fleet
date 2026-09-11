// Where work has got to between a worktree, the checkout it merges into, and the remote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-flow-'))
const out = join(dir, 'flow.cjs')
await build({
  entryPoints: ['src/renderer/src/git/flow.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { stagesOf, nextOf, hostNotes, incomingOf } = await import(`file://${out}`).then((m) => m.default ?? m)

const f = (path) => ({ path, status: 'modified', letter: 'M', staged: false, committed: false })
const st = (o = {}) => ({
  root: '/repo',
  branch: 'wt:agent-2',
  base: 'main',
  upstream: null,
  unpushed: 0,
  unpushedCommits: [],
  behind: 0,
  behindBase: 0,
  ahead: 0,
  staged: [],
  unstaged: [],
  committed: [],
  ...o
})
const at = (stages, key) => stages.find((s) => s.key === key)

test('uncommitted work stops at the first station', () => {
  const s = stagesOf(st({ unstaged: [f('a.ts'), f('b.ts')] }), st(), null, true)
  assert.equal(at(s, 'changed').count, 2)
  assert.equal(at(s, 'changed').state, 'holding')
  assert.equal(at(s, 'staged').state, 'clear')
  assert.equal(nextOf(st({ unstaged: [f('a.ts'), f('b.ts')] }), st(), null).action, 'stage')
})

test('staged before committed', () => {
  const wt = st({ staged: [f('a.ts')] })
  assert.equal(nextOf(wt, st(), null).action, 'commit')
  assert.match(nextOf(wt, st(), null).text, /1 staged file/)
})

// The case that makes a worktree feel like it ate the work: committed on the agent's branch, and
// nowhere else. The old pane showed a clean tree and said nothing about main.
test('committed in the worktree and not merged is not done', () => {
  const wt = st({ ahead: 3 })
  const plan = { ok: true, reason: null, branch: 'wt:agent-2', into: 'main', commits: 3, files: 9, fastForward: true, merged: false, baseUnpushed: 0, at: '/repo' }
  const s = stagesOf(wt, st(), plan, true)
  assert.equal(at(s, 'committed').count, 3)
  assert.equal(at(s, 'merged').count, 3)
  const n = nextOf(wt, st(), plan)
  assert.equal(n.action, 'merge')
  assert.match(n.text, /merge 3 commits into main/)
  assert.equal(n.done, false)
})

test('once merged, the worktree stations go quiet', () => {
  const wt = st({ ahead: 3 })
  const plan = { ok: true, reason: null, branch: 'wt:agent-2', into: 'main', commits: 0, files: 0, fastForward: true, merged: true, baseUnpushed: 3, at: '/repo' }
  const host = st({ branch: 'main', unpushed: 3 })
  assert.equal(at(stagesOf(wt, host, plan, true), 'committed').state, 'clear')
  assert.equal(at(stagesOf(wt, host, plan, true), 'merged').state, 'clear')
  // seen from the main checkout, the same commits are what the remote is missing
  assert.equal(at(stagesOf(host, host, null, false), 'pushed').count, 3)
  // and pushing stays the user's own step: reported, never offered
  const n = nextOf(host, host, null, false)
  assert.equal(n.action, null)
  assert.match(n.text, /push that yourself/)
})

test('a refused merge is a blocked station, not a silent one', () => {
  const wt = st({ ahead: 2 })
  const plan = { ok: false, reason: 'the main checkout has uncommitted changes', branch: 'wt:agent-2', into: 'main', commits: 2, files: 4, fastForward: false, merged: false, baseUnpushed: 0, at: '/repo' }
  assert.equal(at(stagesOf(wt, st(), plan, true), 'merged').state, 'blocked')
  const n = nextOf(wt, st(), plan)
  assert.equal(n.action, null)
  assert.match(n.blocked, /uncommitted changes/)
})

test('everywhere clear reads as done', () => {
  const n = nextOf(st(), st(), null)
  assert.equal(n.done, true)
  assert.equal(n.action, null)
})

test('the remote count comes from the checkout that owns the branch', () => {
  // the worktree's own unpushed count is about its own branch, which is not what gets pushed
  const s = stagesOf(st({ unpushed: 7 }), st({ branch: 'main', unpushed: 2 }), null, false)
  assert.equal(at(s, 'pushed').count, 2)
})

test('the main checkout says what a merge would land in the middle of', () => {
  const notes = hostNotes(st({ branch: 'main', unstaged: [f('x.ts')], behind: 2 }), null)
  assert.match(notes.join(' · '), /1 uncommitted file/)
  assert.match(notes.join(' · '), /2 commits behind/)
})

// The traffic that runs the other way. A branch cut days ago merges into code it has never seen.
test('commits that landed in main after the branch was cut are reported', () => {
  const i = incomingOf(st({ behindBase: 4, base: 'main' }))
  assert.equal(i.count, 4)
  assert.match(i.text, /main has 4 commits this worktree does not/)
  assert.equal(i.blocked, null)
})

test('an up to date worktree has nothing incoming', () => {
  assert.equal(incomingOf(st()), null)
})

test('updating is refused while the worktree has open files', () => {
  const i = incomingOf(st({ behindBase: 2, unstaged: [f('a.ts')], staged: [f('b.ts')] }))
  assert.match(i.blocked, /commit the 2 open files here first/)
})

// Inside a worktree the journey ends at the local main. What the remote has belongs to the main
// checkout, and showing it here only invites pushing from the wrong place.
test('a worktree is never shown the remote', () => {
  const wt = st({ ahead: 0 })
  const host = st({ branch: 'main', unpushed: 2 })
  const plan = { ok: true, reason: null, branch: 'wt:agent-2', into: 'main', commits: 0, files: 0, fastForward: true, merged: true, baseUnpushed: 2, at: '/repo' }
  const keys = stagesOf(wt, host, plan, true).map((s) => s.key)
  assert.deepEqual(keys, ['changed', 'staged', 'committed', 'merged'])
  const n = nextOf(wt, host, plan, true)
  assert.equal(n.done, true)
  assert.match(n.text, /work is in main/)
})

test('outside a worktree there is no main to merge into, and the remote is the question', () => {
  const keys = stagesOf(st({ branch: 'main', unpushed: 2 }), null, null, false).map((s) => s.key)
  assert.deepEqual(keys, ['changed', 'staged', 'committed', 'pushed'])
})

test('the main checkout reports what a merge would land in, not what it owes its remote', () => {
  const notes = hostNotes(st({ branch: 'main', unpushed: 9, unstaged: [f('x.ts')] }), {
    ok: true, reason: null, branch: 'b', into: 'main', commits: 1, files: 1,
    fastForward: true, merged: false, baseUnpushed: 9, at: '/repo'
  })
  assert.equal(notes.length, 1)
  assert.match(notes[0], /1 uncommitted file/)
})
