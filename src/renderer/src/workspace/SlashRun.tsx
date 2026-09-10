import { useEffect, useRef, useState } from 'react'
import { Screen, clean, contentDepth, delta, echoRows, readRun, renderScreen, walk, type Run } from '../../../shared/screen'

const POLL_MS = 700
// how long the screen has to hold still before a command counts as finished
const SETTLE_MS = 1_500
// nothing recognisable after this long means the command left no trace the chat can read
const GRACE_MS = 8_000
// how long the highlight is given to arrive where it was aimed before the pick is abandoned
const AIM_MS = 2_500
// how long a menu that has gone missing, or a hand on the arrow keys, holds off any verdict
const HOLD_MS = 3_000

/**
 * What the terminal is showing for one slash command, in the chat.
 *
 * Claude Code 2.1.266 writes some slash commands to the transcript and not others: `/mcp` leaves a
 * `<command-name>` line, `/skills` and `/diff` leave nothing. Either way it never records what the
 * command answered, so the pty is the only place the answer exists. The card replays that pty onto
 * a screen, finds the command's own echo on it and shows what is under it: printed output for
 * `/skills` and its kind, and for the ones that answer with a menu, the menu itself, as a list the
 * arrow keys walk, followed by whatever the next one is when a choice opens another.
 *
 * This is the command's own surface, not a message: in the terminal the line you type is consumed
 * and what comes back stands on its own, so there is no bubble here either, only a quiet label
 * saying which command the surface belongs to.
 *
 * Best effort by design, in the same way the permission card is. A shape it cannot place is shown
 * as the plain text the terminal drew rather than guessed at, and when nothing on screen can be
 * tied to the command it says so and offers the terminal, which always works.
 */
export function SlashRunCard({
  agentId,
  command,
  before,
  onOpenTerminal,
  onGone,
  onGrow
}: {
  agentId: string
  command: string
  /** the pty buffer from before the keystrokes went in, so an instant answer still reads as new */
  before: Promise<string>
  onOpenTerminal: () => void
  /** the command took content away rather than adding any, so there is nothing to leave behind */
  onGone: () => void
  /**
   * the card is about to be a different height.
   *
   * It starts as one quiet line and can become twenty rows of output plus a row of choices, and
   * the chat only pins itself to the bottom when its list of items changes. Without this the
   * choices for a long menu are drawn below the fold and read as a menu with no choices at all.
   */
  onGrow: () => void
}): JSX.Element | null {
  const [run, setRun] = useState<Run | null>(null)
  const [lost, setLost] = useState(false)
  const [sent, setSent] = useState(false)
  const [missed, setMissed] = useState<string | null>(null)
  // A pick in flight: the arrow keys have gone in and return has not, because which row the
  // highlight actually landed on is read back off the screen first. Reading a menu means guessing
  // which rows are choices and which are group headings, and a guess one row out would confirm a
  // different server than the one that was clicked. Aiming is reversible; return is not.
  const aim = useRef<{ index: number; label: string; at: number } | null>(null)
  // when the user last drove this menu, so a card being stepped through is never concluded on
  const touched = useRef(0)
  const poke = useRef<() => void>(() => {})
  const gone = useRef(onGone)
  gone.current = onGone
  const grew = useRef(onGrow)
  grew.current = onGrow

  useEffect(() => {
    let alive = true
    let screen = new Screen()
    let seen = ''
    let skip = 0
    let wasDeep = 0
    // once this command has answered with a menu it is an interaction, not a print, and the rules
    // for a print stop applying to it
    let sawMenu = false
    let shape = ''
    let stillSince = Date.now()
    let timer: ReturnType<typeof setInterval> | null = null
    const started = Date.now()

    const stop = (): void => {
      if (timer) clearInterval(timer)
      timer = null
    }

    /**
     * Press return, but only once the highlight is provably on the row that was clicked.
     *
     * If it is somewhere else the pick is dropped rather than confirmed, which leaves the menu open
     * and the user a terminal to finish it in. A wrong confirmation could not be taken back.
     */
    const press = (now: Run | null): void => {
      const a = aim.current
      if (!a) return
      const on = now?.options
      if (on?.marked && on.cursor === a.index && on.options[a.index] === a.label) {
        aim.current = null
        window.api.pty.write(agentId, '\r')
        setSent(true)
        setMissed(null)
        return
      }
      if (Date.now() - a.at < AIM_MS) return
      aim.current = null
      setMissed(a.label)
    }

    const tick = async (): Promise<void> => {
      const h = await window.api.pty.history(agentId)
      if (!alive) return
      const d = delta(seen, h)
      if (d.reset) screen = new Screen()
      screen.write(d.text)
      seen = h
      const next = readRun(screen.lines(), command, skip)
      const now = JSON.stringify(next)
      if (now !== shape) {
        shape = now
        stillSince = Date.now()
        setRun(next)
        setSent(false)
        grew.current()
      }
      if (aim.current) press(next)
      // A menu sitting open is settled too, so silence on its own can never mean finished: the
      // options have to be gone before the card stops following. Picking one usually redraws into
      // another menu, and this is what keeps it following through that. It has to be a highlighted
      // menu: a numbered list in Claude's own prose parses the same way and would never end.
      if (next?.options?.marked) {
        sawMenu = true
        return
      }
      // A menu the user is stepping through never removes its own card. Reading a menu off a screen
      // is best effort, and a frame it cannot place must cost a redraw, never the card: the parse
      // used to fail on the last row of `/mcp` and the whole thing vanished mid-arrowing. So a menu
      // that goes missing is given a moment to come back, and a hand on the keys stops any verdict
      // at all.
      if (sawMenu && Date.now() - touched.current < HOLD_MS) return
      if (sawMenu && !next?.options && Date.now() - stillSince < HOLD_MS) return
      if (!next) {
        // nothing found yet, so keep looking: a command that has to think prints nothing at all
        // for a second or two before it prints anything
        if (Date.now() - started < GRACE_MS) return
        stop()
        // A menu that was driven and is now gone leaves nothing to show: the interaction happened,
        // was cancelled or taken, and the terminal is showing no answer to it. Saying the answer
        // could not be read would be untrue, since it was read well enough to drive.
        //
        // Failing that, a screen that ended up emptier than it started is what /clear leaves
        // behind. That test is only for commands that never opened a menu, where having less on
        // the screen is the only sign that anything happened at all.
        if (sawMenu || contentDepth(screen.lines().map(clean)) < wasDeep) gone.current()
        else setLost(true)
        return
      }
      // the command was echoed but printed nothing under it, and nothing is what the terminal is
      // left showing for it
      if (!next.body.length) {
        if (Date.now() - started < GRACE_MS) return
        stop()
        gone.current()
        return
      }
      // printed output stops changing, and that is the only honest end for it
      if (Date.now() - stillSince > SETTLE_MS) stop()
    }

    void before.then((raw) => {
      if (!alive) return
      const rows = renderScreen(raw).map(clean)
      // echoes already on the screen belong to earlier runs of the same command
      skip = echoRows(rows, command).length
      wasDeep = contentDepth(rows)
      void tick()
      timer = setInterval(() => void tick(), POLL_MS)
    })
    // a pick needs an answer sooner than the next poll, so it can ask for one
    poke.current = () => void tick()
    return () => {
      alive = false
      poke.current = () => {}
      stop()
    }
  }, [agentId, command, before])

  // A menu is only offered as a list when the TUI's own highlight was on screen, since everything
  // below drives the real thing with real keystrokes.
  const menu = run?.options?.marked ? run.options : null
  // The row the user is on. Moving it and moving the terminal's highlight are the same act: the
  // arrow key goes to the pty and the row moves here at once, because waiting a poll for the screen
  // to come back would make the list feel broken. Whenever the screen reports a cursor of its own
  // the local row is dropped and the terminal's is used, so the two cannot drift apart silently.
  // what the screen last said, as one comparable value; option labels contain spaces and slashes,
  // so they cannot simply be joined with one of those
  const at = menu ? JSON.stringify([menu.cursor, menu.options]) : ''
  const [local, setLocal] = useState({ at: '', row: 0 })
  const row = local.at === at ? local.row : (menu?.cursor ?? 0)

  const list = useRef<HTMLDivElement>(null)
  const had = useRef(false)
  const opened = useRef(0)
  useEffect(() => {
    // the keyboard belongs to the menu the moment it opens, the way it does in the terminal
    if (menu && !had.current) {
      list.current?.focus()
      opened.current = Date.now()
    }
    had.current = !!menu
  }, [menu])

  /** the terminal needs a moment to redraw before there is anything to read back */
  function soon(): void {
    touched.current = Date.now()
    setTimeout(() => poke.current(), 150)
  }

  function move(step: number): void {
    if (!menu) return
    const to = Math.min(menu.options.length - 1, Math.max(0, row + step))
    if (to === row) return
    window.api.pty.write(agentId, step > 0 ? '\x1b[B' : '\x1b[A')
    setLocal({ at, row: to })
    soon()
  }

  /** aim at a row without walking there one key at a time, which is what a click is */
  function jump(to: number): void {
    if (!menu || to === row) return
    for (const key of walk(row, to)) window.api.pty.write(agentId, key)
    setLocal({ at, row: to })
    soon()
  }

  function commit(): void {
    if (!menu || aim.current) return
    // The return that opened the menu must not also answer it. The list takes focus a fraction of a
    // second after the command goes in, so a second press out of habit would land here and confirm
    // whichever row happened to be first.
    if (Date.now() - opened.current < 500) return
    setMissed(null)
    aim.current = { index: row, label: menu.options[row], at: Date.now() }
    soon()
    setTimeout(() => poke.current(), 450)
  }

  function cancel(): void {
    // Escape has to reach the TUI, not just close this list. A menu still open in the terminal with
    // nothing in the chat saying so is the one state worse than no menu at all.
    aim.current = null
    setMissed(null)
    window.api.pty.write(agentId, '\x1b')
    soon()
  }

  function onKey(e: React.KeyboardEvent): void {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Home: () => jump(0),
      End: () => jump((menu?.options.length ?? 1) - 1),
      Enter: commit,
      Escape: cancel
    }
    const act = keys[e.key]
    if (!act) return
    e.preventDefault()
    e.stopPropagation()
    act()
  }

  // the command as an html id, since it starts with a slash and ids are referenced by aria
  const slug = command.replace(/[^\w-]/g, '')
  const label = (
    <span className="mono shrink-0 text-[10.5px] text-[var(--accent)]" title={`sent to the terminal: ${command}`}>
      {command}
    </span>
  )

  // an echo with nothing under it yet is a command still working, not a command with an answer
  if (!run || (!run.body.length && !run.options)) {
    if (!lost) {
      return (
        <div className="mb-4 flex max-w-[92%] items-center gap-2">
          {label}
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] dot-blink" />
          <span className="lbl">running in the terminal</span>
        </div>
      )
    }
    return (
      <div className="mb-4 max-w-[92%]">
        <button
          onClick={onOpenTerminal}
          className="flex w-full items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-left text-[11px] text-[var(--muted)] hover:border-[var(--muted)]"
        >
          {label}
          ran, but the chat could not read its answer off the terminal.
          <span className="ml-auto shrink-0 underline">open terminal</span>
        </button>
      </div>
    )
  }

  // with the choices drawn as a list of their own, printing them again above it is just noise
  const text = menu ? run.head : run.body

  return (
    <div className="mb-4 max-w-[92%]">
      <div className="mb-1 flex items-baseline gap-2">
        {label}
        <span className="lbl">terminal</span>
        <button onClick={onOpenTerminal} className="lbl ml-auto underline hover:!text-[var(--fg)]">
          open terminal
        </button>
      </div>
      {!!text.length && (
        <pre className="select mono max-h-[420px] overflow-auto whitespace-pre rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-[10px] leading-snug text-[var(--muted)]">
          {text.join('\n')}
        </pre>
      )}
      {menu && (
        <div
          ref={list}
          role="listbox"
          tabIndex={0}
          aria-label={`${command} choices`}
          aria-activedescendant={`${slug}-choice-${row}`}
          onKeyDown={onKey}
          className="mt-1.5 overflow-hidden rounded border border-[var(--line)] bg-[var(--panel)] py-1 outline-none focus:border-[var(--accent)]"
        >
          {menu.rows.map((r) =>
            r.choice === null ? (
              <div key={r.row} className="lbl px-2 pb-0.5 pt-1.5">
                {r.text}
              </div>
            ) : (
              <div
                key={r.row}
                id={`${slug}-choice-${r.choice}`}
                role="option"
                aria-selected={r.choice === row}
                // click to land on a row, click the row you are on to take it; a single click that
                // both moved and confirmed would make a mis-click unrecoverable
                onClick={() => (r.choice === row ? commit() : jump(r.choice as number))}
                className={`mono flex cursor-pointer items-baseline gap-1.5 px-2 py-[3px] text-[11.5px] ${
                  r.choice === row ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'
                }`}
              >
                {/* the terminal's own highlight, which is the one that decides what return picks */}
                <span className="w-2 shrink-0 text-[var(--accent)]">{r.choice === menu.cursor ? '❯' : ' '}</span>
                <span className="min-w-0 truncate">{r.text}</span>
              </div>
            )
          )}
          <div className="lbl px-2 pb-0.5 pt-1.5">↑↓ move · ↵ confirm · esc cancel</div>
        </div>
      )}
      {sent && <div className="mt-1.5 text-[10.5px] text-[var(--dim)]">sent · if nothing happens, answer it in the terminal</div>}
      {missed && (
        <div className="mt-1.5 text-[10.5px] text-[var(--warn)]">
          the highlight did not land on {missed}, so nothing was confirmed · pick it in the terminal
        </div>
      )}
      {!run.anchored && (
        <div className="mt-1.5 text-[10.5px] text-[var(--dim)]">
          the terminal never echoed {command}, so this is what its screen shows rather than a reply to it
        </div>
      )}
    </div>
  )
}
