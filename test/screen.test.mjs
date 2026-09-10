// Reading a slash command's answer off the terminal, which is the only place it exists.
//
// Claude Code 2.1.266 writes no slash command to the transcript, so the chat has to read the pty.
// The pty is not a log of lines: the TUI runs on the alternate screen and repaints single cells at
// absolute positions, so `strip the escapes and split on newlines` collapses a whole session into
// one line. Everything here is about getting the rows back.
//
// `fixtures/claude-tui-2.1.266.raw` is a real capture of `claude` through a pty (script), start to
// finished answer. It has the banner, the spinner frames, the composer box and the status bar, but
// no slash command in it, because none was run. The slash frames below are therefore painted onto
// that real screen with the same absolute-move idiom the capture uses, so the base is measured and
// only the new rows are synthesised. A real /mcp or /model frame could still differ in shape.
//
// Run with: pnpm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-screen-'))
const out = join(dir, 'screen.cjs')
await build({
  entryPoints: ['src/shared/screen.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { Screen, renderScreen, clean, readOptions, contentEnd, contentDepth, echoRows, readRun, delta, walk } =
  await import(`file://${out}`).then((m) => m.default ?? m)

const CAPTURE = readFileSync('test/fixtures/claude-tui-2.1.266.raw', 'utf8')

// The second fixture is a real `/mcp` menu, but it is screen rows rather than bytes: it is what the
// card rendered on a live agent, handed back after the six servers came out as three. Rows, not
// bytes, means the indentation is already gone, which is exactly the information a parser would
// want to tell a group heading from a choice. Say so rather than pretending otherwise.
const MCP = readFileSync('test/fixtures/mcp-menu-2.1.266.screen.txt', 'utf8').replace(/\n$/, '').split('\n')
// what sits under any menu on a real screen, lifted off the capture above
const COMPOSER = ['─'.repeat(80), '❯', '─'.repeat(80), '⏵⏵ auto mode on (shift+tab to cycle)']

/** paint text at an absolute cell, the way the TUI does: home, down, right, write, clear the rest */
const at = (row, col, text) => `\x1b[H\r\x1b[${row}B${col ? `\x1b[${col}C` : ''}${text}\x1b[K`

test('a real 2.1.266 capture renders back to the screen a person saw', () => {
  const lines = renderScreen(CAPTURE)
  assert.match(lines[1], /Claude Code v2\.1\.266/)
  assert.match(lines[3], /~\/repos\/agent-fleet/)
  assert.equal(lines[7], '❯ Think it through, then answer in one word: what is the capital of Sweden?')
  assert.equal(lines[9], '⏺ Stockholm')
  assert.equal(lines[19], '❯', 'the composer sits below the conversation')
})

test('the same capture is one single line to a strip-and-split reader', () => {
  // this is why the screen model exists, not a nicety: the old parser had nothing to look at
  const flat = CAPTURE.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '').split(/\r?\n/)
  assert.equal(flat.length, 1)
})

test('the screen does not care where the chunks were cut', () => {
  const whole = renderScreen(CAPTURE).join('\n')
  for (const size of [1, 3, 64, 997]) {
    const s = new Screen()
    for (let i = 0; i < CAPTURE.length; i += size) s.write(CAPTURE.slice(i, i + size))
    assert.equal(s.lines().join('\n'), whole, `split every ${size} bytes`)
  }
})

test('plain output with no escapes still reads as its own lines', () => {
  // the permission prompt path feeds the same buffers through here, so this must not have changed
  assert.deepEqual(renderScreen('one\r\ntwo\r\n'), ['one', 'two'])
  assert.deepEqual(renderScreen('one\ntwo\n'), ['one', 'two'])
})

test('the conversation ends at the top rule of the composer box', () => {
  const rows = renderScreen(CAPTURE).map(clean)
  assert.equal(contentEnd(rows), 18)
  assert.match(rows[18], /^─+$/)
})

test('a clock ticking in the status bar is below the conversation, so it cannot look like output', () => {
  const rows = renderScreen(CAPTURE).map(clean)
  assert.ok(rows.slice(contentEnd(rows)).some((l) => /14:16/.test(l)))
  assert.ok(!rows.slice(0, contentEnd(rows)).some((l) => /🌿 main/.test(l)))
})

test('the command the TUI echoed is found, and earlier runs of it are countable', () => {
  const rows = ['❯ /skills', 'one', '❯ /skills', 'two', '❯ hello'].map(clean)
  assert.deepEqual(echoRows(rows, '/skills'), [0, 2])
  assert.deepEqual(echoRows(rows, '/nope'), [])
  assert.deepEqual(echoRows(['❯ /commit and push'], '/commit some args'), [0], 'arguments do not have to match')
})

test('a highlighted numbered menu is a menu, and its highlight is reported', () => {
  const found = readOptions(['Select a model', '  1. Default', '❯ 2. Opus', '  3. Sonnet'])
  assert.deepEqual(found.options, ['Default', 'Opus', 'Sonnet'])
  assert.equal(found.cursor, 1)
  assert.equal(found.marked, true)
})

test('a numbered list with no highlight is not something to press keys at', () => {
  const found = readOptions(['Here is the plan:', '1. read the file', '2. change it'])
  assert.equal(found.marked, false, 'prose parses like a menu; only the cursor tells them apart')
})

test('a redrawn menu replaces the one before it instead of stacking', () => {
  const found = readOptions(['1. a', '2. b', '1. a', '❯ 2. b', '3. c'])
  assert.deepEqual(found.options, ['a', 'b', 'c'])
  assert.equal(found.cursor, 1)
})

test('a menu with no numbers is recognised by its highlight', () => {
  const found = readOptions(['Do you trust this folder?', '❯ Yes, proceed', 'No, exit'])
  assert.deepEqual(found.options, ['Yes, proceed', 'No, exit'])
  assert.equal(found.marked, true)
})

test('printed output is what sits between the command echo and the composer', () => {
  const raw = CAPTURE + at(13, 0, '❯ /skills') + at(15, 0, '⏺ Available skills') + at(16, 2, 'code-review · Review a pull request')
  const run = readRun(renderScreen(raw), '/skills', 0)
  assert.equal(run.anchored, true)
  assert.deepEqual(run.body, ['⏺ Available skills', 'code-review · Review a pull request'])
  assert.equal(run.options, null, 'nothing to press')
})

test('the conversation above the command is not mistaken for its output', () => {
  const raw = CAPTURE + at(13, 0, '❯ /cost') + at(15, 0, 'Total cost: $0.42')
  const run = readRun(renderScreen(raw), '/cost', 0)
  assert.ok(!run.body.some((l) => /Stockholm/.test(l)))
})

test('a second run of the same command reads its own answer', () => {
  const raw =
    CAPTURE +
    at(12, 0, '❯ /cost') +
    at(13, 0, 'Total cost: $0.42') +
    at(15, 0, '❯ /cost') +
    at(16, 0, 'Total cost: $0.55')
  assert.deepEqual(readRun(renderScreen(raw), '/cost', 0).body, ['Total cost: $0.42'])
  assert.deepEqual(readRun(renderScreen(raw), '/cost', 1).body, ['Total cost: $0.55'])
})

test('a menu is offered as choices, with the highlight the keys have to walk from', () => {
  const raw =
    CAPTURE +
    at(12, 0, '❯ /model') +
    at(14, 0, 'Select a model') +
    at(15, 2, '1. Default') +
    at(16, 0, '❯ 2. Opus 5') +
    at(17, 2, '3. Sonnet')
  const run = readRun(renderScreen(raw), '/model', 0)
  assert.deepEqual(run.options.options, ['Default', 'Opus 5', 'Sonnet'])
  assert.equal(run.options.cursor, 1)
  assert.equal(run.options.marked, true)
  assert.ok(run.body.includes('Select a model'), 'the question is shown, not only the buttons')
})

test('a menu drawn below the composer is not cut off at the composer', () => {
  // /resume and /agents take over the lower half of the screen; the boundary has to give way
  const raw = CAPTURE + at(12, 0, '❯ /resume') + at(21, 0, '❯ 1. two hours ago') + at(22, 0, '  2. yesterday')
  const run = readRun(renderScreen(raw), '/resume', 0)
  assert.deepEqual(run.options.options, ['two hours ago', 'yesterday'])
  assert.ok(run.body.some((l) => /two hours ago/.test(l)))
})

test('a command that has not reached the screen yet is nothing to draw', () => {
  assert.equal(readRun(renderScreen(CAPTURE), '/skills', 0), null)
})

test('a command echoed with nothing under it is an answer, and the answer is nothing', () => {
  // told apart from the case above so the chat can go quiet rather than claim it failed to read
  const run = readRun(renderScreen(CAPTURE + at(13, 0, '❯ /cost')), '/cost', 0)
  assert.equal(run.anchored, true)
  assert.deepEqual(run.body, [])
  assert.equal(run.options, null)
})

test('a command that wiped the screen is measurably shallower than the one before it', () => {
  // how /clear is recognised without naming it: the terminal ends up with less on it
  const rows = renderScreen(CAPTURE).map(clean)
  const cleared = renderScreen(CAPTURE + '\x1b[2J' + at(1, 0, '▐▛███▛█   Claude Code v2.1.266')).map(clean)
  assert.ok(contentDepth(cleared) < contentDepth(rows))
  assert.equal(readRun(renderScreen(CAPTURE + '\x1b[2J'), '/clear', 0), null, 'no echo survives the wipe')
})

test('the real /mcp menu offers every server, not just the first group', () => {
  const found = readOptions([...MCP, ...COMPOSER].map(clean))
  assert.equal(found.options.length, 6, 'the menu says 6 servers, and it means it')
  assert.deepEqual(found.options.slice(3).map((o) => o.split(' · ')[0]), [
    'browser',
    'plugin:developer-documentation:developer-documentation',
    'plugin:slack:slack'
  ])
  assert.equal(found.cursor, 0)
  assert.equal(found.marked, true)
})

test('a group heading is not a choice, and neither are the key hints under the menu', () => {
  const found = readOptions([...MCP, ...COMPOSER].map(clean))
  for (const not of ['User MCPs', 'Built-in MCPs', 'Manage MCP servers', '6 servers', '↑/↓', 'https://']) {
    assert.ok(!found.options.some((o) => o.startsWith(not)), `${not} must not be pickable`)
  }
})

test('a menu does not change shape as the highlight walks through it', () => {
  // Arrowing down the real /mcp menu used to shrink it: entering the second group made the first
  // one cease to exist, six choices became three, then two, and on the last row there was nothing
  // left to parse, so the card decided the command was over and removed itself.
  const CHOICES = [9, 10, 11, 14, 15, 16]
  for (const [want, on] of CHOICES.entries()) {
    const screen = [...MCP, ...COMPOSER].map((l, i) => (i === on ? `❯ ${l.replace(/^❯\s+/, '')}` : l.replace(/^❯\s+/, '')))
    const found = readOptions(screen.map(clean))
    assert.equal(found?.options.length, 6, `six choices with the highlight on row ${on}`)
    assert.equal(found.cursor, want, `the highlight on row ${on} is choice ${want}`)
    assert.ok(readRun(screen, '/mcp', 0), 'and the run is still readable, so the card stays')
  }
})

test('the headings are kept for reading and left out of what the arrow keys can land on', () => {
  const found = readOptions([...MCP, ...COMPOSER].map(clean))
  assert.deepEqual(
    found.rows.map((r) => [r.choice, r.text.split(' · ')[0]]),
    [
      [null, 'User MCPs (/Users/pontus.alm@m10s.io/.claude.json)'],
      [0, 'mobility-pro-docs'],
      [1, 'obsidian'],
      [2, 'skynex-utility-api'],
      [null, 'Built-in MCPs (always available)'],
      [3, 'browser'],
      [4, 'plugin:developer-documentation:developer-documentation'],
      [5, 'plugin:slack:slack']
    ]
  )
})

test('a numbered menu is all choices, because the numbers are the whole structure', () => {
  const found = readOptions(['Do you want to proceed?', '❯ 1. Yes', '  2. No'])
  assert.deepEqual(found.rows.map((r) => r.choice), [0, 1])
})

test('the menu title is split off, so the choices are not printed once as text and once as a list', () => {
  const run = readRun([...MCP, ...COMPOSER], '/mcp', 0)
  assert.deepEqual(run.head, ['Manage MCP servers', '6 servers'])
  assert.ok(!run.head.some((l) => /mobility-pro-docs/.test(l)), 'the list draws the choices, not the block')
  assert.ok(run.body.some((l) => /mobility-pro-docs/.test(l)), 'the whole thing is still there for anything else')
})

test('printed output with no menu has no head to split off', () => {
  const raw = CAPTURE + at(13, 0, '❯ /cost') + at(15, 0, 'Total cost: $0.42')
  const run = readRun(renderScreen(raw), '/cost', 0)
  assert.deepEqual(run.head, [])
  assert.deepEqual(run.body, ['Total cost: $0.42'])
})

test('a menu with no echo starts at its own top edge, not eight rows up into the conversation', () => {
  // the bug this fixture was handed over for: /mcp showed two sentences of an earlier answer
  const run = readRun([...MCP, ...COMPOSER], '/mcp', 0)
  assert.equal(run.body[0], 'Manage MCP servers')
  assert.ok(!run.body.some((l) => /Config\.fromCluster/.test(l)), 'the conversation above is not the answer')
  assert.ok(!run.body.some((l) => /Crunched for/.test(l)), 'nor is the spinner line')
  assert.equal(run.anchored, false)
})

test('the menu is bounded above by ▔, which is not the ─ the composer draws with', () => {
  const rows = [...MCP, ...COMPOSER].map(clean)
  assert.match(MCP[4], /^▔+$/)
  assert.equal(contentEnd(rows), MCP.length, 'the composer box still wins as the end of the conversation')
})

test('a menu with no echo above it is shown, and flagged as not certainly the command answer', () => {
  const raw = CAPTURE + at(14, 0, 'Choose one') + at(15, 0, '❯ 1. yes') + at(16, 2, '2. no')
  const run = readRun(renderScreen(raw), '/mcp', 0)
  assert.equal(run.anchored, false)
  assert.deepEqual(run.options.options, ['yes', 'no'])
})

test('a permission prompt drawn the 2.1.x way is readable again', async () => {
  const approval = join(dir, 'approval.cjs')
  await build({
    entryPoints: ['src/renderer/src/workspace/Approval.tsx'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: approval,
    logLevel: 'error',
    jsx: 'automatic'
  })
  const { readPrompt } = await import(`file://${approval}`).then((m) => m.default ?? m)
  const raw =
    CAPTURE +
    at(12, 0, '╭──────────────────────────────╮') +
    at(13, 0, '│ Bash command                 │') +
    at(14, 0, '│ rm -rf build                 │') +
    at(15, 0, '│ Do you want to proceed?      │') +
    at(16, 0, '│ ❯ 1. Yes                     │') +
    at(17, 0, '│   2. No, tell Claude (esc)   │')
  const prompt = readPrompt(renderScreen(raw))
  assert.equal(prompt.question, 'Do you want to proceed?')
  assert.deepEqual(prompt.detail, ['Bash command', 'rm -rf build'], 'the conversation above the box is not detail')
  assert.deepEqual(prompt.options, ['Yes', 'No, tell Claude'])
  assert.equal(prompt.cursor, 0)
  assert.equal(readPrompt(renderScreen(CAPTURE)), null, 'a screen with no prompt on it asks nothing')
})

test('only the bytes the screen has not seen are fed back to it', () => {
  assert.deepEqual(delta('abc', 'abcdef'), { text: 'def', reset: false })
  assert.deepEqual(delta('', 'abc'), { text: 'abc', reset: false })
})

test('a ring buffer that dropped its head is re-anchored by overlap, not redrawn', () => {
  // what a saturated ring does: the front falls off between polls while the tail grows
  const seen = CAPTURE.repeat(3)
  assert.deepEqual(delta(seen, seen.slice(500) + 'NEW'), { text: 'NEW', reset: false })
})

test('a buffer with nothing in common means the screen starts over', () => {
  assert.deepEqual(delta(CAPTURE, 'unrelated'), { text: 'unrelated', reset: true })
})

test('walking the highlight goes the right way, the right number of times', () => {
  assert.deepEqual(walk(0, 2), ['\x1b[B', '\x1b[B'])
  assert.deepEqual(walk(2, 0), ['\x1b[A', '\x1b[A'])
  assert.deepEqual(walk(1, 1), [])
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
