// The session state machine, tested without a filesystem.
//
// Every wrong-looking card this project has shipped was a wrong branch in stateOf(): SessionStart
// painting idle agents green, an unparsed tool result pinning a session running for ten minutes,
// a subagent between two tool calls reading as idle. Those cases are all in here, so the next one
// fails a test instead of being noticed on screen.
//
// Run with: pnpm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-test-'))
const out = join(dir, 'tailer.cjs')
await build({
  entryPoints: ['src/main/sessions/tailer.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error',
  external: ['electron']
})
const { stateOf } = await import(`file://${out}`).then((m) => m.default ?? m)

const hooksOut = join(dir, 'hooks.cjs')
await build({
  entryPoints: ['src/shared/hooks.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: hooksOut,
  logLevel: 'error'
})
const { claimFor } = await import(`file://${hooksOut}`).then((m) => m.default ?? m)

const NOW = Date.parse('2026-01-01T12:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const SECOND = 1000
const MINUTE = 60 * SECOND

function session(over = {}) {
  return {
    id: 's1',
    cwd: '/repo',
    repoPath: '/repo',
    repo: 'repo',
    parentId: null,
    closed: false,
    hookState: null,
    turnEnded: false,
    currentTool: null,
    transcript: [],
    lastEventAt: ago(SECOND),
    ...over
  }
}
const item = (kind, agoMs) => ({ kind, ts: ago(agoMs), text: '' })
const state = (over) => stateOf(session(over), NOW).state

test('a closed session is ended whatever else it says', () => {
  assert.equal(state({ closed: true, transcript: [item('tool', SECOND)] }), 'ended')
})

test('untouched for a day is ended', () => {
  assert.equal(state({ lastEventAt: ago(25 * 60 * MINUTE) }), 'ended')
})

test('untouched for twenty minutes is stale, not idle', () => {
  assert.equal(state({ lastEventAt: ago(20 * MINUTE), transcript: [item('text', 20 * MINUTE)] }), 'stale')
})

test('an empty transcript is idle, not running', () => {
  assert.equal(state({ transcript: [] }), 'idle')
})

test('an open tool call means running', () => {
  // nothing written since the call started, so it is still in flight
  assert.equal(state({ lastEventAt: ago(30 * SECOND), transcript: [item('tool', 30 * SECOND)] }), 'running')
})

test('a tool call left open by a killed session eventually stops counting', () => {
  // the regression that made every agent look busy after a restart: a call nothing can still be
  // running stops meaning running, well before the session is old enough to be called stale
  assert.equal(state({ lastEventAt: ago(9 * MINUTE), transcript: [item('tool', 9 * MINUTE)] }), 'running')
  assert.equal(state({ lastEventAt: ago(11 * MINUTE), transcript: [item('tool', 11 * MINUTE)] }), 'idle')
  assert.equal(state({ lastEventAt: ago(20 * MINUTE), transcript: [item('tool', 20 * MINUTE)] }), 'stale')
})

test('a tool call with newer lines after it decays fast, not over ten minutes', () => {
  // the result was written but not in a shape the parser recognised: it is a pause, not work
  const s = session({ lastEventAt: ago(30 * SECOND), transcript: [item('tool', 90 * SECOND)] })
  assert.equal(stateOf(s, NOW).state, 'idle')
})

test('an answer that stopped coming hands the turn back', () => {
  assert.equal(state({ transcript: [item('text', 2 * SECOND)] }), 'running')
  assert.equal(state({ transcript: [item('text', 30 * SECOND)] }), 'idle')
})

test('a fresh prompt is running, an old one is not', () => {
  assert.equal(state({ transcript: [item('prompt', 5 * SECOND)] }), 'running')
  assert.equal(state({ transcript: [item('prompt', 60 * SECOND)] }), 'idle')
})

test('a subagent between two tool calls is thinking, not idle', () => {
  assert.equal(state({ parentId: 'p1', lastEventAt: ago(30 * SECOND), transcript: [] }), 'running')
  assert.equal(state({ parentId: 'p1', lastEventAt: ago(2 * MINUTE), transcript: [] }), 'running')
  assert.equal(state({ parentId: 'p1', lastEventAt: ago(4 * MINUTE), transcript: [] }), 'idle')
})

test('a hook claim of running wins, but only while it is fresh', () => {
  const claim = (agoMs) => ({ state: 'running', at: ago(agoMs) })
  assert.equal(state({ hookState: claim(5 * SECOND), transcript: [] }), 'running')
  // a stale claim pins a finished agent green forever, so it expires
  assert.equal(state({ hookState: claim(2 * MINUTE), transcript: [] }), 'idle')
  // and it expires on the short window, just past it, not on idle's ten minutes
  assert.equal(state({ hookState: claim(46 * SECOND), transcript: [] }), 'idle')
})

test('a hook claim of waiting is kept, since only a hook can know it', () => {
  assert.equal(state({ hookState: { state: 'waiting', at: ago(SECOND) }, transcript: [] }), 'waiting')
})

test('a hook claim of waiting outlives the short running window', () => {
  // a permission prompt is true until a tool hook contradicts it. On the 45 s window it expired
  // while the prompt was still on screen, the open tool call below took over, and the card went
  // green for ten minutes with the agent in fact blocked on the user.
  const claim = (agoMs) => ({ state: 'waiting', at: ago(agoMs) })
  // the tool call the prompt is asking about, still open with nothing written since
  const open = { lastEventAt: ago(6 * MINUTE), transcript: [item('tool', 6 * MINUTE)] }
  assert.equal(state({ ...open, hookState: claim(46 * SECOND) }), 'waiting')
  assert.equal(state({ ...open, hookState: claim(5 * MINUTE) }), 'waiting')
})

test('a hook claim of idle beats an open tool call', () => {
  const s = session({ hookState: { state: 'idle', at: ago(SECOND) }, transcript: [item('tool', 5 * SECOND)] })
  assert.equal(stateOf(s, NOW).state, 'idle')
})

test('going idle clears the current tool, staying running does not', () => {
  assert.equal(stateOf(session({ transcript: [item('text', 60 * SECOND)] }), NOW).clearTool, true)
  assert.equal(stateOf(session({ transcript: [item('tool', 5 * SECOND)] }), NOW).clearTool, false)
})


// ---- hook claims -----------------------------------------------------------
// The mapping both processes read. SessionStart claiming "running" is the bug that painted every
// freshly opened agent green; it is the case most worth pinning down.

test('SessionStart claims nothing: it is not work', () => {
  assert.equal(claimFor('SessionStart'), null)
})

test('prompts and tool calls claim running', () => {
  assert.equal(claimFor('UserPromptSubmit'), 'running')
  assert.equal(claimFor('PreToolUse'), 'running')
  assert.equal(claimFor('PostToolUse'), 'running')
})

test('a permission prompt is waiting, any other notification is not', () => {
  assert.equal(claimFor('Notification', 'permission_prompt'), 'waiting')
  assert.equal(claimFor('Notification', 'anything_else'), 'idle')
})

test('Stop hands the turn back, SessionEnd closes it', () => {
  assert.equal(claimFor('Stop'), 'idle')
  assert.equal(claimFor('SessionEnd'), 'ended')
})

test('an unknown event claims nothing rather than guessing', () => {
  assert.equal(claimFor('PreCompact'), null)
  assert.equal(claimFor(''), null)
})

test('a subagent mid-tool-call stays running however long the call takes', () => {
  // the bug this covers: a search that ran longer than a minute made the subagent vanish
  const s = session({
    parentId: 'p1',
    lastEventAt: ago(4 * MINUTE),
    transcript: [item('tool', 4 * MINUTE)]
  })
  assert.equal(stateOf(s, NOW).state, 'running')
})

test('a finished turn is idle at once, not after the settle window', () => {
  // the transcript says the turn ended; nothing has to be inferred from how recent the line is
  const s = session({ turnEnded: true, lastEventAt: ago(SECOND), transcript: [item('text', SECOND)] })
  assert.equal(stateOf(s, NOW).state, 'idle')
  assert.equal(stateOf(s, NOW).clearTool, true)
})

test('a turn that continues into a tool call is still running', () => {
  const s = session({ turnEnded: false, lastEventAt: ago(SECOND), transcript: [item('tool', SECOND)] })
  assert.equal(stateOf(s, NOW).state, 'running')
})

test('a hook that arrived after the last line still wins', () => {
  // a new prompt raises a hook a second before the transcript catches up
  const s = session({
    turnEnded: true,
    lastEventAt: ago(30 * SECOND),
    hookState: { state: 'running', at: ago(2 * SECOND) },
    transcript: [item('text', 30 * SECOND)]
  })
  assert.equal(stateOf(s, NOW).state, 'running')
})

test('a finished turn goes stale like anything else once it is old', () => {
  const s = session({ turnEnded: true, lastEventAt: ago(20 * MINUTE), transcript: [item('text', 20 * MINUTE)] })
  assert.equal(stateOf(s, NOW).state, 'stale')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
