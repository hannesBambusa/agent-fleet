import { readFileSync, writeFileSync } from 'node:fs'
import { Screen, clean, contentEnd, delta, readOptions } from '../../shared/screen'
import type { CatalogItem } from '../../shared/types'

/**
 * Claude Code's own slash commands, which exist in no file on this machine.
 *
 * The catalog's other three sources are read from the same directories Claude Code reads. Its
 * built-ins are compiled into a 200 MB minified bundle where the names appear hundreds of times
 * with no manifest, so pattern-matching the binary would silently produce garbage, and a hand
 * written list is a guess that goes stale in the direction of missing the most used command.
 *
 * So ask Claude Code. Type `/` into a session, read the menu it draws, take the character back.
 * That costs a keystroke in a terminal somebody is watching, so it happens once per Claude Code
 * version and the answer is cached; every later session on that version reads the file.
 */

export interface BuiltinCommand {
  name: string
  description: string
}

export interface BuiltinCache {
  /** the Claude Code version whose menu this was read from */
  version: string
  at: string
  commands: BuiltinCommand[]
}

/** what the TUI prints in its banner, which is the version of the process that drew the menu */
const BANNER = /Claude Code v(\d+\.\d+\.\d+[\w.+-]*)/

/** the composer's input row, whatever is on it */
const INPUT = /^[❯>](.*)$/

/**
 * A menu row: the command, then a gap, then what it does. The highlight marker is optional because
 * only one row of the menu carries it, and the description is optional because a row can be too
 * narrow for one.
 */
const MENU_ROW = /^(?:[❯>]\s+)?\/([a-z][a-z0-9:._-]*)(?:\s{2,}(\S.*?))?\s*$/

/** enough rows of the same shape that the screen can only be showing a menu, not prose */
const MENU_PROOF = 5

/** below this the menu was not read whole, and half a list is worse than the fallback */
const MIN_COMMANDS = 12

/**
 * Two commands every version of Claude Code has. Seeing both is the proof that the walk covered the
 * menu rather than one page of it: they are far enough apart in the alphabet that a single page
 * cannot hold them both on any terminal this app opens.
 */
const CERTAIN = ['clear', 'help']

export function readCache(file: string): BuiltinCache | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuiltinCache>
    if (typeof raw?.version !== 'string' || !Array.isArray(raw.commands)) return null
    const commands = raw.commands.filter(
      (c) => c && typeof c.name === 'string' && typeof c.description === 'string'
    )
    if (!commands.length) return null
    return { version: raw.version, at: typeof raw.at === 'string' ? raw.at : '', commands }
  } catch {
    return null
  }
}

export function writeCache(file: string, cache: BuiltinCache): void {
  try {
    writeFileSync(file, JSON.stringify(cache, null, 2))
  } catch (err) {
    console.error('[builtins] could not write the cache', err)
  }
}

/**
 * The cached commands as catalog entries.
 *
 * `path` is empty because there is no file: this list came off a running session's own menu. Every
 * consumer that offers to open a catalog item has to cope with that.
 */
export function cacheItems(cache: BuiltinCache | null): CatalogItem[] {
  if (!cache) return []
  return cache.commands.map((c) => ({
    kind: 'command' as const,
    name: c.name,
    description: c.description,
    source: 'built-in' as const,
    origin: 'Claude Code',
    path: '',
    model: null,
    tools: null,
    hint: null,
    userOnly: false,
    at: cache.at || null
  }))
}

export function builtinItems(file: string): CatalogItem[] {
  return cacheItems(readCache(file))
}

export function bannerVersion(rows: string[]): string | null {
  for (const r of rows) {
    const m = BANNER.exec(r)
    if (m) return m[1]
  }
  return null
}

/**
 * What is typed into the composer, or null when there is no composer on screen to read.
 *
 * The input sits on the first row below the rule that ends the conversation. Null is the answer
 * that matters before the probe types anything: a screen this cannot read is a screen it must not
 * write to.
 */
export function composerText(rows: string[]): string | null {
  for (let i = contentEnd(rows) + 1; i < rows.length; i++) {
    const line = rows[i].trim()
    if (!line) continue
    const m = INPUT.exec(line)
    return m ? m[1].trim() : null
  }
  return null
}

export function composerEmpty(rows: string[]): boolean {
  return composerText(rows) === ''
}

/** every command the slash menu is currently showing, deduped, best description kept */
export function readMenu(rows: string[]): BuiltinCommand[] {
  const found = new Map<string, string>()
  for (const r of rows) {
    const m = MENU_ROW.exec(r)
    if (!m) continue
    const [, name, description = ''] = m
    // the same row can be read again while scrolling, once wide enough for its description
    if (description || !found.has(name)) found.set(name, description || found.get(name) || '')
  }
  return [...found].map(([name, description]) => ({ name, description }))
}

/**
 * What in a menu reading is Claude Code's own, or null when the reading cannot be trusted.
 *
 * The menu lists everything typable, so custom commands and skills are in it too. Whatever no file
 * on this machine accounts for is what Claude Code brought with it. `known` carries both spellings a
 * menu can use for one file, the bare name and the plugin's namespaced one.
 */
export function builtinsFrom(menu: BuiltinCommand[], known: Set<string>): BuiltinCommand[] | null {
  if (menu.length < MIN_COMMANDS) return null
  if (!CERTAIN.every((n) => menu.some((c) => c.name === n))) return null
  const own = menu.filter((c) => !known.has(c.name))
  return own.length ? own : null
}

/** the part of a PtyManager a probe needs, so this module never has to load node-pty */
export interface ProbePty {
  write(id: string, data: string): void
  historyOf(id: string): string
  alive(id: string): boolean
}

export interface ProbeTiming {
  /** how long to wait for the TUI to finish drawing before giving up without typing */
  readyMs: number
  /** how long the menu gets to appear after the slash */
  menuMs: number
  pollMs: number
  /** hard cap on how far the highlight is walked down the list */
  steps: number
  /** stop walking once this many steps in a row have offered nothing new */
  quiet: number
}

export const TIMING: ProbeTiming = { readyMs: 20_000, menuMs: 5_000, pollMs: 60, steps: 120, quiet: 12 }

const DOWN = '\x1b[B'
const BACKSPACE = '\x7f'
const ESC = '\x1b'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Ask one running session what Claude Code's commands are.
 *
 * The caller owns the decision to run this at all, because only the caller knows the session is
 * fresh. Everything here is about backing out: any screen that does not look the way it should ends
 * the probe, and the slash is removed again and the removal verified off the screen rather than
 * assumed. Returning null means nothing was learned and the fallback list stands, which is the
 * correct outcome for every failure: a wrong list is worse than a stale one.
 */
export async function probeBuiltins(
  ptys: ProbePty,
  id: string,
  file: string,
  known: () => Set<string>,
  timing: ProbeTiming = TIMING
): Promise<BuiltinCache | null> {
  const screen = new Screen()
  let seen = ''
  let rotated = false
  let typed = false

  // the pty history is a ring, and a probe that missed bytes is a probe reading a screen that never
  // existed; feeding only the new tail is also what keeps each poll cheap
  const read = (): string[] => {
    const next = ptys.historyOf(id)
    const d = delta(seen, next)
    if (d.reset && seen) rotated = true
    screen.write(d.text)
    seen = next
    return screen.lines().map(clean)
  }

  // Once this has run there is nothing further to try, so it is never run twice: a second backspace
  // into a composer that did not come back empty would delete a character the probe did not put
  // there. The escape is for the case where the menu outlives the character that opened it.
  const restore = async (): Promise<boolean> => {
    typed = false
    for (const key of [BACKSPACE, ESC]) {
      ptys.write(id, key)
      for (let i = 0; i < 20; i++) {
        await wait(timing.pollMs)
        const rows = read()
        if (composerEmpty(rows) && !readMenu(rows).length) return true
      }
    }
    return false
  }

  const fail = async (why: string): Promise<null> => {
    console.error('[builtins] probe abandoned:', why)
    if (typed && !(await restore())) {
      console.error('[builtins] the slash could not be taken back off the composer')
    }
    return null
  }

  try {
    // 1. wait until the session is drawn and quiet: a banner, an empty composer, nothing to answer
    const readyBy = Date.now() + timing.readyMs
    let rows = read()
    for (;;) {
      if (!ptys.alive(id)) return fail('the session ended before it was ready')
      if (rotated) return fail('the pty history rotated under the probe')
      if (bannerVersion(rows) && composerEmpty(rows) && !readOptions(rows)) break
      if (Date.now() > readyBy) return fail('the session never settled on an empty composer')
      await wait(timing.pollMs)
      rows = read()
    }
    const version = bannerVersion(rows)!
    const cached = readCache(file)
    // the banner is the version of the process about to be typed into, so it is the last word on
    // whether this is already known
    if (cached?.version === version) return cached

    // 2. one character, and only one. Nothing moves on until the screen shows both halves of what
    //    that character did: the slash sitting alone in the composer, and a run of rows that can
    //    only be a menu. Down with no menu open is prompt history, which would put somebody's last
    //    message in their composer, so this is the check that has to hold before any arrow key.
    ptys.write(id, '/')
    typed = true
    const menuBy = Date.now() + timing.menuMs
    for (;;) {
      await wait(timing.pollMs)
      rows = read()
      if (!ptys.alive(id)) return fail('the session ended while the menu was drawing')
      if (rotated) return fail('the pty history rotated under the probe')
      if (composerText(rows) === '/' && readMenu(rows).length >= MENU_PROOF) break
      if (Date.now() > menuBy) return fail('no menu appeared')
    }

    // 3. walk the highlight down. The menu shows a window onto a longer list, so the names arrive a
    //    page at a time; a list that already fits simply repeats itself and the walk stops early.
    const found = new Map(readMenu(rows).map((c) => [c.name, c.description]))
    for (let step = 0, quiet = 0; step < timing.steps && quiet < timing.quiet; step++) {
      ptys.write(id, DOWN)
      await wait(timing.pollMs)
      rows = read()
      if (!ptys.alive(id)) return fail('the session ended while the menu was being read')
      if (rotated) return fail('the pty history rotated under the probe')
      const before = found.size
      for (const c of readMenu(rows)) if (c.description || !found.has(c.name)) found.set(c.name, c.description)
      quiet = found.size === before ? quiet + 1 : 0
    }

    // 4. give the composer back before deciding anything, and check rather than assume
    if (!(await restore())) return fail('the composer did not come back empty')

    const commands = builtinsFrom(
      [...found].map(([name, description]) => ({ name, description })),
      known()
    )
    if (!commands) return fail('the menu did not read like a menu')
    const cache: BuiltinCache = { version, at: new Date().toISOString(), commands }
    writeCache(file, cache)
    return cache
  } catch (err) {
    console.error('[builtins] probe failed', err)
    if (typed) await restore()
    return null
  }
}
