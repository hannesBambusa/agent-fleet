// Asking Claude Code what its own slash commands are, and what happens when the answer is not there.
//
// The list of built-in commands exists in no file: the installed binary is a 200 MB minified bundle
// with no manifest in it. The only honest source is a running session's own menu, so the probe types
// a slash into a freshly launched agent, reads the menu off the rendered screen, and takes the
// character back. Everything about that is unverifiable from a fixture except the parts that are
// pure, which are all in here.
//
// What is NOT covered: a real /-menu frame. `fixtures/claude-tui-2.1.266.raw` is a real capture of a
// session, but no slash command was ever typed in it, so the menu frames below are painted onto that
// real screen with the same absolute-move idiom the capture uses. A real menu could sit somewhere
// else on the screen, use a different marker, or wrap its descriptions. The parser scans every row
// rather than a region, so where it sits does not matter; the row shape is the guess.
//
// Run with: pnpm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-builtins-'))
const out = join(dir, 'builtins.cjs')
const screenOut = join(dir, 'screen.cjs')
await build({
  entryPoints: ['src/main/catalog/builtins.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
await build({
  entryPoints: ['src/shared/screen.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: screenOut,
  logLevel: 'error'
})
const {
  bannerVersion,
  builtinsFrom,
  cacheItems,
  composerEmpty,
  composerText,
  probeBuiltins,
  readCache,
  readMenu,
  writeCache
} = await import(`file://${out}`).then((m) => m.default ?? m)
const { renderScreen, clean } = await import(`file://${screenOut}`).then((m) => m.default ?? m)

const CAPTURE = readFileSync('test/fixtures/claude-tui-2.1.266.raw', 'utf8')
const rowsOf = (raw) => renderScreen(raw).map(clean)

/** paint text at an absolute cell, the way the TUI does: home, down, right, write, clear the rest */
const at = (row, col, text) => `\x1b[H\r\x1b[${row}B${col ? `\x1b[${col}C` : ''}${text}\x1b[K`

// what a menu row looks like: two spaces of gutter, the command, a gap, what it does
const MENU = [
  ['add-dir', 'Add a new working directory'],
  ['agents', 'Manage agent configurations'],
  ['clear', 'Clear conversation history and free up context'],
  ['compact', 'Clear conversation history but keep a summary in context'],
  ['config', 'Open config panel'],
  ['context', 'Visualize current context usage as a colored grid'],
  ['cost', 'Show the total cost and duration of the current session'],
  ['doctor', 'Diagnose and verify your Claude Code installation'],
  ['exit', 'Exit the REPL'],
  ['help', 'Show help and available commands'],
  ['mcp', 'Manage MCP servers'],
  ['model', 'Set the AI model for Claude Code'],
  ['resume', 'Resume a conversation'],
  ['usage', 'Show plan usage limits'],
  // the menu lists everything typable, so what is on disk is in it too
  ['code-review', 'Code review a pull request'],
  ['caveman:caveman-commit', 'Generate terse caveman-style commit message']
]

const MENU_TOP = 21
const paintMenu = () =>
  at(19, 0, '❯ /') + MENU.map(([name, desc], i) => at(MENU_TOP + i, 0, `  /${name}`.padEnd(30) + desc)).join('')
const clearMenu = () => at(19, 0, '❯') + MENU.map((_, i) => at(MENU_TOP + i, 0, '')).join('')

const KNOWN = new Set(['code-review', 'global:code-review', 'caveman-commit', 'caveman:caveman-commit'])

test('the version comes off the banner of the session that is about to be typed into', () => {
  assert.equal(bannerVersion(rowsOf(CAPTURE)), '2.1.266')
  assert.equal(bannerVersion(['nothing here']), null)
})

test('an empty composer is what makes a session safe to type into', () => {
  assert.equal(composerEmpty(rowsOf(CAPTURE)), true)
  assert.equal(composerEmpty(rowsOf(CAPTURE + at(19, 0, '❯ where were we'))), false, 'a draft is not ours to touch')
  assert.equal(composerEmpty(rowsOf(CAPTURE + paintMenu())), false, 'the slash we typed counts as a draft too')
  assert.equal(composerEmpty([]), false, 'a screen with no composer on it yet is not an empty one')
})

test('the composer is read back, so the slash can be seen to have landed before any arrow key', () => {
  // a down arrow with no menu open pages the prompt history into the composer, so "the menu is up"
  // has to be something the screen said, not something the probe assumed
  assert.equal(composerText(rowsOf(CAPTURE + paintMenu())), '/')
  assert.equal(composerText(rowsOf(CAPTURE)), '')
  assert.equal(composerText([]), null, 'no composer is not an empty composer')
})

test('the menu is read off the screen, names and descriptions both', () => {
  const menu = readMenu(rowsOf(CAPTURE + paintMenu()))
  assert.equal(menu.length, MENU.length)
  assert.deepEqual(
    menu.find((c) => c.name === 'mcp'),
    { name: 'mcp', description: 'Manage MCP servers' }
  )
  assert.ok(menu.some((c) => c.name === 'caveman:caveman-commit'), 'a namespaced plugin command is one row too')
})

test('a command named in ordinary prose is not a menu row', () => {
  // the capture's own banner carries "⚠ 1 MCP server needs authentication · run /mcp"
  assert.deepEqual(readMenu(rowsOf(CAPTURE)), [])
})

test('the highlight marker on the selected row does not change what the row says', () => {
  const menu = readMenu(['❯ /model    Set the AI model for Claude Code'])
  assert.deepEqual(menu, [{ name: 'model', description: 'Set the AI model for Claude Code' }])
})

test('what a file on this machine accounts for is not a built-in', () => {
  const found = builtinsFrom(readMenu(rowsOf(CAPTURE + paintMenu())), KNOWN)
  assert.ok(found.some((c) => c.name === 'mcp'))
  assert.ok(!found.some((c) => c.name === 'code-review'), 'a command with a file is not Claude Code’s')
  assert.ok(!found.some((c) => c.name === 'caveman:caveman-commit'), 'nor is a plugin’s')
})

test('half a menu is refused, because half a list reads as the other half not existing', () => {
  const short = MENU.slice(0, 6).map(([name, description]) => ({ name, description }))
  assert.equal(builtinsFrom(short, new Set()), null)
})

test('a menu missing a command every version has was not read whole', () => {
  const noHelp = MENU.filter(([n]) => n !== 'help').map(([name, description]) => ({ name, description }))
  assert.equal(builtinsFrom(noHelp, new Set()), null, 'the walk stopped before the end of the alphabet')
})

test('a cache written by one version is read back by the next session on it', () => {
  const file = join(dir, 'cache.json')
  const cache = { version: '2.1.266', at: '2026-09-10T09:00:00.000Z', commands: [{ name: 'mcp', description: 'Manage MCP servers' }] }
  writeCache(file, cache)
  assert.deepEqual(readCache(file), cache)
})

test('a cache that is not there, or not readable, is simply not a cache', () => {
  assert.equal(readCache(join(dir, 'nothing.json')), null)
  const junk = join(dir, 'junk.json')
  writeCache(junk, { version: 2, commands: 'no' })
  assert.equal(readCache(junk), null)
})

test('cached commands arrive as catalog items with no file behind them', () => {
  const [item] = cacheItems({ version: '2.1.266', at: 'now', commands: [{ name: 'mcp', description: 'Manage MCP servers' }] })
  assert.equal(item.kind, 'command')
  assert.equal(item.source, 'built-in')
  assert.equal(item.origin, 'Claude Code')
  assert.equal(item.path, '', 'nothing to open')
  assert.deepEqual(cacheItems(null), [])
})

/**
 * A pty that draws the capture, opens the menu on a slash and closes it on a backspace.
 *
 * `answers` is what it does with each key, so a test can make it refuse to close the menu and watch
 * the probe back out. Arrow keys change nothing here, which is the case where the whole list already
 * fits on screen: the walk goes quiet and stops.
 */
function fakePty({ menu = true, restores = true } = {}) {
  let raw = CAPTURE
  return {
    written: [],
    write(_id, data) {
      this.written.push(data)
      if (data === '/' && menu) raw += paintMenu()
      else if (data === '/') raw += at(19, 0, '❯ /')
      else if ((data === '\x7f' || data === '\x1b') && restores) raw += clearMenu()
    },
    historyOf: () => raw,
    alive: () => true
  }
}

const QUICK = { readyMs: 200, menuMs: 100, pollMs: 4, steps: 40, quiet: 5 }

test('a probe reads the menu, puts the slash back, and caches what no file accounts for', async () => {
  const file = join(dir, 'probe.json')
  const pty = fakePty()
  const cache = await probeBuiltins(pty, 'a1', file, () => KNOWN, QUICK)
  assert.equal(cache.version, '2.1.266')
  assert.ok(cache.commands.some((c) => c.name === 'mcp'))
  assert.ok(!cache.commands.some((c) => c.name === 'code-review'))
  assert.deepEqual(readCache(file), cache, 'the next session on this version reads it off disk')
  assert.equal(pty.written[0], '/', 'one character, and it is the first thing sent')
  assert.equal(pty.written.filter((k) => k === '/').length, 1)
  assert.ok(pty.written.includes('\x7f'), 'and it is taken back')
  assert.equal(composerEmpty(rowsOf(pty.historyOf())), true)
})

test('a second probe on a version already cached types nothing at all', async () => {
  const file = join(dir, 'probe.json')
  const pty = fakePty()
  const cache = await probeBuiltins(pty, 'a1', file, () => KNOWN, QUICK)
  assert.equal(cache.version, '2.1.266')
  assert.deepEqual(pty.written, [], 'the banner said it was already known')
})

test('a menu that never draws leaves the fallback standing and the composer clean', async () => {
  const file = join(dir, 'nomenu.json')
  const pty = fakePty({ menu: false })
  assert.equal(await probeBuiltins(pty, 'a2', file, () => KNOWN, QUICK), null)
  assert.equal(existsSync(file), false, 'nothing learned is nothing written')
  assert.ok(pty.written.includes('\x7f'))
  assert.equal(composerEmpty(rowsOf(pty.historyOf())), true)
})

test('a composer that will not come back empty abandons the reading it already had', async () => {
  const file = join(dir, 'stuck.json')
  const pty = fakePty({ restores: false })
  assert.equal(await probeBuiltins(pty, 'a3', file, () => KNOWN, QUICK), null)
  assert.equal(existsSync(file), false, 'a screen the probe cannot read back is one it cannot be trusted on')
  assert.equal(pty.written.filter((k) => k === '\x7f').length, 1, 'never a second backspace: it would eat a real character')
})

test('a session that never settles is never typed into', async () => {
  const pty = { written: [], write(_i, d) { this.written.push(d) }, historyOf: () => '', alive: () => true }
  assert.equal(await probeBuiltins(pty, 'a4', join(dir, 'never.json'), () => KNOWN, QUICK), null)
  assert.deepEqual(pty.written, [])
})

test('a session that ends under the probe is not typed into either', async () => {
  const pty = { written: [], write(_i, d) { this.written.push(d) }, historyOf: () => CAPTURE, alive: () => false }
  assert.equal(await probeBuiltins(pty, 'a5', join(dir, 'gone.json'), () => KNOWN, QUICK), null)
  assert.deepEqual(pty.written, [])
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
