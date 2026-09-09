// Slash commands in the transcript, on lines copied out of ~/.claude/projects on this machine.
//
// Claude Code records a command and what it printed in two shapes, a `user` line for some commands
// and a `system` line with subtype `local_command` for others, and it writes the same invocation
// down twice when the command is interactive. Every case below is a real sequence, because the
// shapes are the whole problem: the parser dropped the system one entirely, so `/mcp` and `/skills`
// ran and the chat showed nothing.
//
// Run with: pnpm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-test-'))
const out = join(dir, 'parse.cjs')
await build({
  entryPoints: ['src/main/sessions/parse.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error',
  external: ['electron']
})
const { applyLine } = await import(`file://${out}`).then((m) => m.default ?? m)

// verbatim lines, so the escapes inside them survive as escapes rather than as characters
const SYS_MCP = String.raw`{"parentUuid":"41fb11ca-ae59-4def-ab69-1e01214fcf34","isSidechain":false,"type":"system","subtype":"local_command","content":"<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>","level":"info","timestamp":"2026-08-19T08:39:27.560Z","uuid":"cda69cd2-d7a8-4bde-8c62-fc46d4b415d0","isMeta":false,"cwd":"/Users/x/repos","sessionId":"0e0e935d","version":"2.1.235","gitBranch":"HEAD"}`
const SYS_MCP_OUT = String.raw`{"parentUuid":"cda69cd2-d7a8-4bde-8c62-fc46d4b415d0","isSidechain":false,"type":"system","subtype":"local_command","content":"<local-command-stdout>Reconnected to plugin:slack:slack.</local-command-stdout>","level":"info","timestamp":"2026-08-19T08:39:27.560Z","uuid":"2ae0401d-c2ea-45f8-9182-fd5716ad9981","isMeta":false,"cwd":"/Users/x/repos","sessionId":"0e0e935d","version":"2.1.235","gitBranch":"HEAD"}`
const USER_AGENTS = String.raw`{"parentUuid":"d49631cf-5ce3-4fae-95bb-abc1f4dac742","isSidechain":false,"type":"user","message":{"role":"user","content":"<command-name>/agents</command-name>\n            <command-message>agents</command-message>\n            <command-args></command-args>"},"uuid":"3a7e5891-90e1-4c4a-9cfd-3f5cafc328f6","timestamp":"2026-08-19T08:42:23.472Z","cwd":"/Users/x/repos","sessionId":"0e0e935d","version":"2.1.235","gitBranch":"HEAD"}`
const SYS_AGENTS_OUT = String.raw`{"parentUuid":"3a7e5891-90e1-4c4a-9cfd-3f5cafc328f6","isSidechain":false,"type":"system","subtype":"local_command","content":"<local-command-stdout>The /agents wizard has been removed.\n\nDocs: https://code.claude.com/docs/en/sub-agents</local-command-stdout>","level":"info","timestamp":"2026-08-19T08:42:23.472Z","uuid":"744ffd66-a74b-4e67-9043-df681390fa2e","isMeta":false,"cwd":"/Users/x/repos","sessionId":"0e0e935d","version":"2.1.235","gitBranch":"HEAD"}`

// one /mcp, driven through its picker: a user pair for the reconnect it did, then a system pair
// seven seconds later for dismissing the dialog
const BOTH_SHAPES = [
  String.raw`{"parentUuid":"111f2f12","isSidechain":false,"type":"user","message":{"role":"user","content":"<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>"},"uuid":"eeb1d942-071e-43ec-a8e5-90cf64f85707","timestamp":"2026-08-10T09:26:31.816Z","cwd":"/Users/x/repos","sessionId":"e4de15fd","version":"2.1.226","gitBranch":"HEAD"}`,
  String.raw`{"parentUuid":"eeb1d942-071e-43ec-a8e5-90cf64f85707","isSidechain":false,"type":"user","message":{"role":"user","content":"<local-command-stdout>Failed to reconnect to obsidian: -32000</local-command-stdout>"},"uuid":"cfd9ad0e-2cd1-4ea0-951e-716c45307d8d","timestamp":"2026-08-10T09:26:31.816Z","cwd":"/Users/x/repos","sessionId":"e4de15fd","version":"2.1.226","gitBranch":"HEAD"}`,
  String.raw`{"parentUuid":"cfd9ad0e-2cd1-4ea0-951e-716c45307d8d","isSidechain":false,"type":"system","subtype":"local_command","content":"<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>","level":"info","timestamp":"2026-08-10T09:26:38.572Z","uuid":"f6f702b8-4057-4611-9c5e-4a62a077a440","isMeta":false,"cwd":"/Users/x/repos","sessionId":"e4de15fd","version":"2.1.226","gitBranch":"HEAD"}`,
  String.raw`{"parentUuid":"f6f702b8-4057-4611-9c5e-4a62a077a440","isSidechain":false,"type":"system","subtype":"local_command","content":"<local-command-stdout>MCP dialog dismissed</local-command-stdout>","level":"info","timestamp":"2026-08-10T09:26:38.572Z","uuid":"9393085d-dd3d-4a32-9132-f3f88d11777f","isMeta":false,"cwd":"/Users/x/repos","sessionId":"e4de15fd","version":"2.1.226","gitBranch":"HEAD"}`
]

/** the same line again, restamped, which is how a second run of one command looks */
function restamped(line, timestamp, uuid) {
  return JSON.stringify({ ...JSON.parse(line), timestamp, uuid })
}

function session() {
  return {
    transcript: [],
    turns: 0,
    parentId: null,
    currentTool: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
}

const feed = (s, ...lines) => lines.map((l) => applyLine(s, l))
const kinds = (s) => s.transcript.map((i) => i.kind)

test('a local_command line puts the command in the transcript', () => {
  const s = session()
  assert.deepEqual(feed(s, SYS_MCP), [true])
  assert.deepEqual(kinds(s), ['command'])
  assert.equal(s.transcript[0].text, '/mcp')
  assert.equal(s.lastCommand, '/mcp')
  assert.equal(s.turns, 1)
})

test('what a local_command printed lands under it, not as a tool result', () => {
  const s = session()
  feed(s, SYS_MCP, SYS_MCP_OUT)
  assert.deepEqual(kinds(s), ['command', 'system'])
  assert.equal(s.transcript[1].text, 'Reconnected to plugin:slack:slack.')
  assert.equal(s.transcript[1].isError, false)
})

test('a command that arrives as a user line still produces exactly one item', () => {
  const s = session()
  feed(s, USER_AGENTS)
  assert.deepEqual(kinds(s), ['command'])
  assert.equal(s.transcript[0].text, '/agents')
  assert.equal(s.turns, 1)
  // its output is written as the other shape, and belongs to the same chip
  feed(s, SYS_AGENTS_OUT)
  assert.deepEqual(kinds(s), ['command', 'system'])
  assert.match(s.transcript[1].text, /^The \/agents wizard has been removed\./)
})

test('one invocation written down in both shapes is one command, with both outputs', () => {
  const s = session()
  feed(s, ...BOTH_SHAPES)
  assert.deepEqual(kinds(s), ['command', 'system', 'system'])
  assert.equal(s.turns, 1)
  assert.deepEqual(
    s.transcript.map((i) => i.text),
    ['/mcp', 'Failed to reconnect to obsidian: -32000', 'MCP dialog dismissed']
  )
})

test('running the same command again later is its own command', () => {
  const s = session()
  feed(s, SYS_MCP, SYS_MCP_OUT, restamped(SYS_MCP, '2026-08-19T08:45:00.000Z', 'later'))
  assert.deepEqual(kinds(s), ['command', 'system', 'command'])
  assert.equal(s.turns, 2)
})

test('a failing command is marked, and long output is clamped like a tool result', () => {
  // no /command has written stderr on this machine yet, so this line is a real one with its tag
  // swapped; the shape is the same one Claude Code uses for stdout
  const s = session()
  const err = SYS_MCP_OUT.replaceAll('local-command-stdout', 'local-command-stderr')
  feed(s, SYS_MCP, err)
  assert.equal(s.transcript[1].isError, true)

  const long = JSON.stringify({
    type: 'system',
    subtype: 'local_command',
    uuid: 'long',
    timestamp: '2026-08-19T08:39:28.000Z',
    content: `<local-command-stdout>${'x'.repeat(5000)}</local-command-stdout>`
  })
  feed(s, long)
  assert.equal(s.transcript[2].text.length, 2000)
})

test('other system lines are still ignored', () => {
  const s = session()
  const line = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c', timestamp: '2026-08-19T08:39:29.000Z' })
  assert.deepEqual(feed(s, line), [false])
  assert.deepEqual(kinds(s), [])
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
