import { useEffect, useRef, useState } from 'react'
import { Screen, clean, contentDepth, delta, echoRows, readRun, renderScreen, walk, type Run } from '../../../shared/screen'

const POLL_MS = 700
// how long the screen has to hold still before a command counts as finished
const SETTLE_MS = 1_500
// nothing recognisable after this long means the command left no trace the chat can read
const GRACE_MS = 8_000
// how long the highlight is given to arrive where it was aimed before the pick is abandoned
const AIM_MS = 2_500

/**
 * What the terminal is showing for one slash command, in the chat.
 *
 * Claude Code 2.1.x writes no slash command to the transcript, so the pty is the only record that
 * one was run. The card replays that pty onto a screen, finds the command's own echo on it and
 * shows what is under it: printed output for `/skills` and its kind, clickable choices for the ones
 * that answer with a menu, and the menu after that when a choice opens another.
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
      if (next?.options?.marked) return
      if (!next) {
        // nothing found yet, so keep looking: a command that has to think prints nothing at all
        // for a second or two before it prints anything
        if (Date.now() - started < GRACE_MS) return
        stop()
        // A screen that ended up emptier than it started is what /clear leaves behind: the command
        // did its job and took content with it. The terminal shows no answer afterwards, so the
        // chat shows nothing either, rather than a stub.
        if (contentDepth(screen.lines().map(clean)) < wasDeep) gone.current()
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

  function choose(index: number): void {
    const options = run?.options
    if (!options || aim.current) return
    setMissed(null)
    for (const key of walk(options.cursor, index)) window.api.pty.write(agentId, key)
    aim.current = { index, label: options.options[index], at: Date.now() }
    // the TUI needs a moment to redraw the highlight before there is anything to read back
    setTimeout(() => poke.current(), 120)
    setTimeout(() => poke.current(), 400)
  }

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

  // buttons drive the real TUI, so they are only offered when its highlight was actually on screen
  const pickable = run.options?.marked ? run.options : null

  return (
    <div className="mb-4 max-w-[92%]">
      <div className="mb-1 flex items-baseline gap-2">
        {label}
        <span className="lbl">terminal</span>
        <button onClick={onOpenTerminal} className="lbl ml-auto underline hover:!text-[var(--fg)]">
          open terminal
        </button>
      </div>
      {!!run.body.length && (
        <pre className="select mono max-h-[420px] overflow-auto whitespace-pre rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-[10px] leading-snug text-[var(--muted)]">
          {run.body.join('\n')}
        </pre>
      )}
      {pickable && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {/* the body above already lists these; without a word here the row of pills reads as
              part of the output rather than as the thing to press */}
          <span className="lbl mr-0.5">pick one</span>
          {pickable.options.map((o, i) => (
            <button
              key={i}
              disabled={sent}
              onClick={() => choose(i)}
              className={`rounded border px-2.5 py-1 text-[11px] disabled:opacity-40 ${
                i === pickable.cursor
                  ? 'border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)] hover:brightness-110'
                  : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              {o}
            </button>
          ))}
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
