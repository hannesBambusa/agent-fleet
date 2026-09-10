/**
 * The smallest terminal that can answer "what does the screen say", plus the two things worth
 * reading off it: the rows a command printed, and the choices a menu is offering.
 *
 * Claude Code 2.1.x draws on the alternate screen with absolute cursor moves and repaints only the
 * cells that changed, so a frame can be `home · down 16 · one spinner glyph`. Stripping the escapes
 * and splitting on newlines gives one endless line, which is why reading the pty buffer as text
 * stopped working. Replaying the bytes onto a grid is the only way back to the rows a person sees.
 */

// how far the grid is allowed to grow, so a runaway stream cannot eat memory
const MAX_ROWS = 400
const MAX_COLS = 600

/** a CSI ends at the first byte in this range; everything before it is parameters and intermediates */
const CSI_FINAL = /[\x40-\x7e]/

export class Screen {
  private rows: string[][] = []
  private r = 0
  private c = 0
  private saved = { r: 0, c: 0 }
  // a chunk can end mid-sequence, so the unfinished tail waits here for the next one
  private rest = ''

  write(data: string): void {
    const s = this.rest + data
    this.rest = ''
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === '\x1b') {
        const used = this.escape(s, i)
        // incomplete: keep it and wait rather than printing the fragment as text
        if (used < 0) {
          this.rest = s.slice(i)
          return
        }
        i += used
        continue
      }
      if (ch === '\r') {
        this.c = 0
      } else if (ch === '\n') {
        // ptys run with ONLCR, so a newline arrives as CR LF and the column is already 0. Moving to
        // column 0 here as well keeps plain non-TUI output rendering exactly as splitting on \n did.
        this.r++
        this.c = 0
      } else if (ch === '\x08') {
        this.c = Math.max(0, this.c - 1)
      } else if (ch >= ' ') {
        this.put(ch)
      }
      i++
    }
  }

  /** what the screen says, one string per row, trailing blanks cut */
  lines(): string[] {
    return this.rows.map((row) => row.join('').replace(/\s+$/, ''))
  }

  private put(ch: string): void {
    if (this.r >= MAX_ROWS || this.c >= MAX_COLS) return
    const row = this.row(this.r)
    while (row.length < this.c) row.push(' ')
    row[this.c] = ch
    this.c++
  }

  private row(n: number): string[] {
    while (this.rows.length <= n) this.rows.push([])
    return this.rows[n]
  }

  private clearRow(n: number, from: number, to: number): void {
    const row = this.row(n)
    const end = to === Infinity ? row.length : Math.min(to, MAX_COLS)
    while (row.length < end) row.push(' ')
    for (let i = from; i < end; i++) row[i] = ' '
  }

  /** the length of the escape sequence at `i`, or -1 when the chunk cut it short */
  private escape(s: string, i: number): number {
    const kind = s[i + 1]
    if (kind === undefined) return -1
    if (kind === '[') return this.csi(s, i)
    // OSC, DCS, PM and APC all run until BEL or ST and none of them paint
    if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
      const bel = s.indexOf('\x07', i + 2)
      const st = s.indexOf('\x1b\\', i + 2)
      if (bel < 0 && st < 0) return -1
      if (st >= 0 && (bel < 0 || st < bel)) return st + 2 - i
      return bel + 1 - i
    }
    // charset selection and the like: two bytes of payload, no effect on placement
    if (kind === '(' || kind === ')' || kind === '*' || kind === '+' || kind === '#' || kind === '%') {
      return s[i + 2] === undefined ? -1 : 3
    }
    if (kind === '7') this.saved = { r: this.r, c: this.c }
    else if (kind === '8') this.restore()
    else if (kind === 'M') this.r = Math.max(0, this.r - 1)
    else if (kind === 'D') this.r++
    else if (kind === 'E') {
      this.r++
      this.c = 0
    } else if (kind === 'c') this.reset()
    return 2
  }

  private csi(s: string, i: number): number {
    let j = i + 2
    while (j < s.length && !CSI_FINAL.test(s[j])) j++
    if (j >= s.length) return -1
    const body = s.slice(i + 2, j)
    const final = s[j]
    const used = j + 1 - i
    // private sequences (?, >, <, =) are modes and queries; only the alternate screen moves anything
    if (/^[?><=]/.test(body)) {
      if ((final === 'h' || final === 'l') && /^\?(1049|47|1047)/.test(body)) this.reset()
      return used
    }
    const p = body.split(';').map((x) => (x === '' ? 0 : Number(x)))
    const n = Math.max(1, p[0] || 0)
    switch (final) {
      case 'H':
      case 'f':
        this.r = Math.max(0, (p[0] || 1) - 1)
        this.c = Math.max(0, (p[1] || 1) - 1)
        break
      case 'A':
        this.r = Math.max(0, this.r - n)
        break
      case 'B':
        this.r += n
        break
      case 'C':
        this.c += n
        break
      case 'D':
        this.c = Math.max(0, this.c - n)
        break
      case 'E':
        this.r += n
        this.c = 0
        break
      case 'F':
        this.r = Math.max(0, this.r - n)
        this.c = 0
        break
      case 'd':
        this.r = Math.max(0, (p[0] || 1) - 1)
        break
      case 'G':
      case '`':
        this.c = Math.max(0, (p[0] || 1) - 1)
        break
      case 'J':
        this.eraseDisplay(p[0] || 0)
        break
      case 'K':
        this.eraseLine(p[0] || 0)
        break
      case 'X':
        this.clearRow(this.r, this.c, this.c + n)
        break
      case 'P':
        this.row(this.r).splice(this.c, n)
        break
      case '@':
        this.row(this.r).splice(this.c, 0, ...Array(n).fill(' '))
        break
      case 'L':
        if (this.rows.length < MAX_ROWS) this.rows.splice(this.r, 0, ...Array.from({ length: n }, () => []))
        break
      case 'M':
        this.rows.splice(this.r, n)
        break
      case 's':
        this.saved = { r: this.r, c: this.c }
        break
      case 'u':
        this.restore()
        break
      default:
        // colour, scroll regions, device reports: nothing lands in a cell
        break
    }
    if (this.r >= MAX_ROWS) this.r = MAX_ROWS - 1
    return used
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0)
      for (let n = this.r + 1; n < this.rows.length; n++) this.rows[n] = []
      return
    }
    if (mode === 1) {
      for (let n = 0; n < this.r; n++) this.rows[n] = []
      this.eraseLine(1)
      return
    }
    this.rows = []
  }

  private eraseLine(mode: number): void {
    if (mode === 0) this.row(this.r).length = Math.min(this.row(this.r).length, this.c)
    else if (mode === 1) this.clearRow(this.r, 0, this.c + 1)
    else this.row(this.r).length = 0
  }

  private restore(): void {
    this.r = this.saved.r
    this.c = this.saved.c
  }

  private reset(): void {
    this.rows = []
    this.r = 0
    this.c = 0
  }
}

/** one-shot: the screen a whole buffer leaves behind */
export function renderScreen(raw: string): string[] {
  const s = new Screen()
  s.write(raw)
  return s.lines()
}

// enough of the old tail to be sure the match is the real seam and not a repeated frame
const OVERLAP = 4096

/**
 * The part of a pty buffer a screen has not been fed yet.
 *
 * `pty.history` is a ring: once the session has printed more than it holds, every read drops bytes
 * off the front, so the new read no longer starts with the old one. Re-rendering the whole buffer
 * each poll costs tens of milliseconds on the render thread, so the seam is found by overlap
 * instead, and a full redraw is the last resort.
 */
export function delta(seen: string, next: string): { text: string; reset: boolean } {
  if (next.startsWith(seen)) return { text: next.slice(seen.length), reset: false }
  const tail = seen.slice(-OVERLAP)
  const at = tail ? next.lastIndexOf(tail) : -1
  if (at >= 0) return { text: next.slice(at + tail.length), reset: false }
  return { text: next, reset: true }
}

/** the arrow keys that move a TUI highlight from one row to another; the caller presses return */
export function walk(from: number, to: number): string[] {
  const key = to > from ? '\x1b[B' : '\x1b[A'
  return Array<string>(Math.abs(to - from)).fill(key)
}

// Claude Code draws prompts and menus inside a box, so every row arrives wrapped in border glyphs
const BORDER_L = /^[\s│┃|╭╰├┌└]+/
const BORDER_R = /[\s│┃|╮╯┤┐┘]+$/
const OPTION = /^\s*(❯|>)?\s*(\d+)[.)]\s+(.+?)\s*$/

export function clean(line: string): string {
  return line.replace(BORDER_L, '').replace(BORDER_R, '')
}

export interface Options {
  options: string[]
  /** which one the TUI has highlighted, so a choice knows how far to walk */
  cursor: number
  /** the row the first option sits on, which is where the text above it stops */
  first: number
  /** the row the last option sits on */
  at: number
  /**
   * whether the highlight was actually seen.
   *
   * A numbered list in ordinary prose parses exactly like a menu, and the difference is the cursor:
   * a live menu always draws one. Callers that are about to send keystrokes must insist on this;
   * the permission prompt, which is only ever read when the session is already blocked, does not.
   */
  marked: boolean
}

/**
 * The choices a TUI menu is offering, or null.
 *
 * Numbered first, because that is what a permission prompt and most command menus print. A run that
 * restarts at 1 replaces the one before it, which is what keeps a redrawn menu from stacking up.
 */
export function readOptions(lines: string[]): Options | null {
  const options: string[] = []
  let cursor = 0
  let first = -1
  let at = -1
  let marked = false
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION.exec(lines[i])
    if (!m) continue
    const index = Number(m[2])
    if (index === 1) {
      options.length = 0
      cursor = 0
      marked = false
      first = i
    }
    if (index !== options.length + 1) continue
    if (m[1]) {
      cursor = options.length
      marked = true
    }
    options.push(m[3].replace(/\s*\(esc\)\s*$/i, ''))
    at = i
  }
  if (options.length >= 2 && at !== -1) return { options, cursor, first, at, marked }
  return bareSelect(lines)
}

/**
 * A row that closes a menu rather than belonging to it: the key hints and the help link every
 * Claude Code menu prints under its choices. Matched on shape where possible, since the wording is
 * the CLI's and could be translated.
 */
function menuFooter(l: string): boolean {
  if (/^https?:\/\//i.test(l)) return true
  if (l.includes('↑') && l.includes('↓')) return true
  return /\besc\b/i.test(l) && /\benter\b/i.test(l)
}

/** the first row of the unbroken run of text that `i` sits in */
function groupTop(rows: string[], i: number): number {
  let top = i
  while (top > 0 && rows[top - 1]) top--
  return top
}

/**
 * Some menus list their choices without numbers, so the highlight is the only thing marking them.
 *
 * A blank line inside such a menu is a group separator, not the end of it. `/mcp` prints six
 * servers under two headings, and stopping at the first gap offered three of them, so the last
 * three could not be picked at all. The choices therefore run from the marker's own group down
 * through every group after it, as far as the footer.
 *
 * Telling a heading from a choice is the weak point, because the screen model has already thrown
 * the indentation away. The rule is positional and inferred from a single real `/mcp` capture:
 * when a menu has more than one group, the first row of each group is that group's heading. A
 * single-group menu keeps the older, narrower reading, choices from the marker downwards, so every
 * shape that already worked is untouched. What makes this safe to act on is not the rule but
 * `SlashRun`, which moves the highlight and checks where it landed before pressing return.
 */
function bareSelect(lines: string[]): Options | null {
  const rows = lines.map((l) => l.trim())
  const marker = rows.map((l, i) => ({ l, i })).filter(({ l }) => /^❯\s+\S/.test(l)).pop()
  if (!marker) return null
  const terse = (l: string): boolean => l.length < 90 && !/[.:]$/.test(l)

  const groups: number[][] = []
  let group: number[] = []
  for (let i = groupTop(rows, marker.i); i < rows.length; i++) {
    const l = rows[i]
    if (!l) {
      if (group.length) groups.push(group)
      group = []
      // one blank separates two groups of choices, two of them end the menu
      if (!rows[i + 1]) break
      continue
    }
    if (RULE.test(l) || menuFooter(l) || !terse(l)) break
    group.push(i)
  }
  if (group.length) groups.push(group)

  const picks =
    groups.length > 1 ? groups.flatMap((g) => g.slice(1)) : (groups[0] ?? []).filter((i) => i >= marker.i)
  const cursor = picks.indexOf(marker.i)
  if (picks.length < 2 || cursor < 0) return null
  return {
    options: picks.map((i) => rows[i].replace(/^❯\s+/, '')),
    cursor,
    first: picks[0],
    at: picks[picks.length - 1],
    marked: true
  }
}

// The composer is a boxed input, and the rules that draw it are where the conversation stops. The
// eighth-block glyphs are in here because a menu draws its own top edge with `▔`, not with the `─`
// the composer uses, and that edge is the only honest boundary above a menu that has no echo.
const RULE = /^[─━—▔▁=_-]{8,}$/

/**
 * The row where the conversation area ends, which is the top rule of the composer box.
 *
 * Below it sit the input, the hints and the status bar, and the status bar changes every second
 * because it carries a clock. Anything that decides "this is new" by comparing screens has to stop
 * here or it reports the clock.
 */
export function contentEnd(rows: string[]): number {
  const rules: number[] = []
  for (let i = 0; i < rows.length; i++) if (RULE.test(rows[i].trim())) rules.push(i)
  if (!rules.length) return rows.length
  const last = rules[rules.length - 1]
  // the box is two rules a few rows apart; the conversation ends at the first of the pair
  for (let k = rules.length - 2; k >= 0; k--) if (last - rules[k] <= 10) return rules[k]
  return last
}

/**
 * How many rows of conversation the terminal is showing.
 *
 * The measure exists to answer one question: did the command take content away? `/clear` leaves a
 * screen that is emptier than the one before it, and that is the difference between a command that
 * quietly did its job and one whose answer could not be read.
 */
export function contentDepth(rows: string[]): number {
  return rows.slice(0, contentEnd(rows)).filter((l) => l.trim().length > 0).length
}

/** the rows where the TUI has echoed this command back, oldest first */
export function echoRows(rows: string[], command: string): number[] {
  const token = command.trim().split(/\s+/)[0]
  const out: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const m = /^[❯>]\s+(\S.*)$/.exec(rows[i].trim())
    if (m && m[1].startsWith(token)) out.push(i)
  }
  return out
}

export interface Run {
  /** the rows the terminal is showing for this command */
  body: string[]
  options: Options | null
  /**
   * whether the command's own echo was found above the body.
   *
   * False means the body is only what the screen happens to be showing, which is worth saying out
   * loud rather than presenting as the command's answer.
   */
  anchored: boolean
}

const blankish = (l: string): boolean => !l.trim() || RULE.test(l.trim())

/**
 * Where the block a menu sits in starts, for a menu the terminal never echoed a command above.
 *
 * This used to be a fixed number of rows above the first choice, which on a full screen simply
 * landed in the middle of the conversation: `/mcp` showed two sentences of an earlier answer and a
 * spinner line as if they were its output. A menu draws its own top edge, so the nearest rule above
 * the choices is the real boundary, and a gap of two blank rows is the fallback when there is none.
 */
function blockTop(rows: string[], first: number): number {
  let blanks = 0
  for (let i = first - 1; i >= 0; i--) {
    const l = rows[i].trim()
    if (RULE.test(l)) return i + 1
    if (!l) {
      if (++blanks >= 2) return i + 2
    } else blanks = 0
  }
  return 0
}

/**
 * What the terminal is showing for one slash command, read off the screen.
 *
 * `skip` is how many echoes of the same command were already on screen when it was sent, so a
 * second `/skills` in one session reads its own output and not the first one's.
 */
export function readRun(lines: string[], command: string, skip: number): Run | null {
  const rows = lines.map(clean)
  const echoes = echoRows(rows, command)
  const start = echoes.length > skip ? echoes[skip] + 1 : -1
  let options = readOptions(rows)
  if (start < 0 && !options) return null
  // a menu can be drawn below the composer, and cutting it off there would hide half of it
  let end = Math.max(contentEnd(rows), options ? options.at + 1 : 0)
  // the same command run again ends this one: everything under the later echo belongs to that run
  const next = echoes.find((i) => i >= start)
  if (start >= 0 && next !== undefined && next < end) {
    end = next
    if (options && options.at >= next) options = null
  }
  // with no echo to start from, show the block the menu sits in rather than the whole screen
  const from = start >= 0 ? start : options ? blockTop(rows, options.first) : 0
  const body = rows.slice(from, Math.max(from, end))
  while (body.length && blankish(body[0])) body.shift()
  while (body.length && blankish(body[body.length - 1])) body.pop()
  // an echo with nothing under it is still an answer, the answer being that the command printed
  // nothing; only a screen with no trace of the command at all is nothing to report
  if (!body.length && !options && start < 0) return null
  return { body, options, anchored: start >= 0 }
}
