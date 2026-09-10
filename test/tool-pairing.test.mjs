// Tool calls paired with their results, tested without a filesystem.
//
// Tool rows kept a green `running` label after the turn had finished, because a result was handed
// to whichever call came last rather than to the call it names. The lines below are lifted from a
// real transcript (session 40f17c94-c10f-45aa-a97d-8f7af8044433): two calls were in flight at once
// and came back in the opposite order, so positional pairing gave the second call both results and
// the first call none.
//
// Run with: pnpm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-test-'))

async function bundle(entry, name) {
  const out = join(dir, name)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error',
    jsx: 'automatic',
    // the chat view pulls in xterm's stylesheet, which node has no use for
    loader: { '.css': 'empty' },
    external: ['electron']
  })
  return import(`file://${out}`).then((m) => m.default ?? m)
}

const { applyLine } = await bundle('src/main/sessions/parse.ts', 'parse.cjs')
const { toTurns, hideClaimed, commandToken } = await bundle('src/renderer/src/workspace/turns.ts', 'turns.cjs')

const BASH = 'toolu_vrtx_019jBzMfXK97z44ZGhGLjb9Z'
const READ = 'toolu_vrtx_01GD6qF6Pbe7mui8aytpH7Mz'

const call = (uuid, ts, blocks) =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: ts, message: { role: 'assistant', content: blocks } })
const answer = (uuid, ts, blocks) =>
  JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: blocks } })
const use = (id, name, input) => ({ type: 'tool_use', id, name, input })
const result = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: text })

function session() {
  return {
    id: 's1',
    parentId: null,
    transcript: [],
    // the command timeline down the side of the chat; only the slash-command path writes to it
    commands: [],
    turns: 0,
    currentTool: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
}

function feed(lines) {
  const s = session()
  for (const l of lines) applyLine(s, l)
  return s.transcript
}

// the real shape: one call per assistant line, both in flight, results in the opposite order
const INTERLEAVED = [
  call('8729bbf4', '2026-09-09T12:38:04.573Z', [use(BASH, 'Bash', { command: 'ls -la', description: 'List k8s and scripts dirs' })]),
  call('5ee1af07', '2026-09-09T12:38:05.113Z', [use(READ, 'Read', { file_path: '/repo/Dockerfile' })]),
  answer('5b8da82c', '2026-09-09T12:38:05.814Z', [result(READ, '1\tFROM eclipse-temurin:21-jdk AS build')]),
  answer('1b285bfe', '2026-09-09T12:38:06.822Z', [result(BASH, '/repo/k8s')])
]

// the same two calls batched the other way round: both in one message, both answered in one message
const BATCHED = [
  call('8729bbf4', '2026-09-09T12:38:04.573Z', [
    use(BASH, 'Bash', { command: 'ls -la', description: 'List k8s and scripts dirs' }),
    use(READ, 'Read', { file_path: '/repo/Dockerfile' })
  ]),
  answer('5b8da82c', '2026-09-09T12:38:05.814Z', [result(BASH, '/repo/k8s'), result(READ, '1\tFROM eclipse-temurin:21-jdk AS build')])
]

test('the parser keeps the tool_use id on both the call and its result', () => {
  const items = feed(INTERLEAVED)
  assert.deepEqual(
    items.map((i) => [i.kind, i.toolUseId]),
    [
      ['tool', BASH],
      ['tool', READ],
      ['result', READ],
      ['result', BASH]
    ]
  )
})

test('two calls in one message keep distinct item ids as well as their tool_use ids', () => {
  const items = feed(BATCHED)
  const tools = items.filter((i) => i.kind === 'tool')
  assert.deepEqual(
    tools.map((i) => i.toolUseId),
    [BASH, READ]
  )
  // the item id is the React key, so the two calls of one message must not collide
  assert.notEqual(tools[0].id, tools[1].id)
  assert.deepEqual(
    items.filter((i) => i.kind === 'result').map((i) => i.toolUseId),
    [BASH, READ]
  )
})

test('every call in a finished turn has its result, whatever order they came back in', () => {
  const [turn] = toTurns(feed(INTERLEAVED))
  // before the ids were carried through, the Read call took both results and the Bash call kept
  // rendering `running` for the rest of the session
  assert.deepEqual(
    turn.tools.map((t) => [t.tool, t.result?.text]),
    [
      ['Bash', '/repo/k8s'],
      ['Read', '1\tFROM eclipse-temurin:21-jdk AS build']
    ]
  )
})

test('a batch of calls answered in one message pairs up the same way', () => {
  const [turn] = toTurns(feed(BATCHED))
  assert.deepEqual(
    turn.tools.map((t) => [t.tool, t.result?.text]),
    [
      ['Bash', '/repo/k8s'],
      ['Read', '1\tFROM eclipse-temurin:21-jdk AS build']
    ]
  )
})

test('an item parsed before the id existed still pairs with the last call', () => {
  // a session already in the ring when the app updated has no toolUseId on either side
  const items = feed(INTERLEAVED).map(({ toolUseId, ...rest }) => rest)
  const [turn] = toTurns(items)
  assert.equal(turn.tools[1].result?.text, '1\tFROM eclipse-temurin:21-jdk AS build')
})

test('a result whose call is no longer in the transcript is left off, not misfiled', () => {
  // the ring keeps 400 items, so an old call can be gone while its result is still there
  const items = feed(INTERLEAVED).filter((i) => i.toolUseId !== BASH)
  const [turn] = toTurns(items)
  assert.equal(turn.tools.length, 1)
  assert.equal(turn.tools[0].result?.text, '1\tFROM eclipse-temurin:21-jdk AS build')
})

// A slash command must appear once, as its own surface, never as a message. Claude Code 2.1.266
// records some of them in the transcript and not others: this is the real `/mcp` line off Hannes's
// session at 09:47:34 UTC, which came back as a green `you` bubble beside the card.
const MCP_LINE = JSON.stringify({
  type: 'user',
  uuid: 'c0ffee',
  timestamp: '2026-09-10T09:47:34.812Z',
  message: {
    role: 'user',
    content:
      '<command-name>/mcp</command-name>\n <command-message>mcp</command-message>\n <command-args></command-args>'
  }
})

test('a command the composer sent is not also drawn as a message', () => {
  const turns = toTurns(feed([MCP_LINE]))
  assert.equal(turns.length, 1, 'the transcript really does record this one')
  assert.equal(turns[0].command, true)
  const claims = [{ token: 'mcp', at: Date.parse('2026-09-10T09:47:34.106Z') }]
  assert.deepEqual(hideClaimed(turns, claims), [])
})

test('the slash is not part of the name, whichever side of the wire it came from', () => {
  // the composer sends `/mcp`, the CLI has written both `/mcp` and `mcp` inside <command-name>
  assert.equal(commandToken('/mcp'), 'mcp')
  assert.equal(commandToken('mcp'), 'mcp')
  assert.equal(commandToken('/commit skip the tests'), 'commit')
  assert.equal(commandToken('  /MCP  '), 'mcp')
})

test('the same command run earlier keeps its place in the history', () => {
  const turns = toTurns(feed([MCP_LINE]))
  // a claim made after the fact cannot reach back and erase a command from an hour ago
  const claims = [{ token: 'mcp', at: Date.parse('2026-09-10T10:47:34.000Z') }]
  assert.equal(hideClaimed(turns, claims).length, 1)
})

test('an unclaimed command, and anything Claude said, are left alone', () => {
  const turns = toTurns(feed([MCP_LINE]))
  assert.equal(hideClaimed(turns, [{ token: 'skills', at: Date.parse('2026-09-10T09:47:34.106Z') }]).length, 1)
  assert.deepEqual(hideClaimed([], [{ token: 'mcp', at: 0 }]), [])
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
