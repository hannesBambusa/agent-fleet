import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, Session, SessionCommand, TranscriptEdit, TranscriptItem } from '../../../shared/types'
import { age, clock, dur, tokens as fmtTokens } from '../lib/format'
import { Markdown } from './Markdown'
import { useCountUp } from '../lib/useCountUp'
import { ApprovalCard } from './Approval'
import { SlashRunCard } from './SlashRun'
import { termSize } from '../terminal/Terminal'
import { Divider } from '../lib/Divider'
import { useQuick } from '../state/quickCommands'
import { toggleToolRows, useToolRows } from '../state/toolRows'
import { SlashMenu, useCatalogItems } from './SlashMenu'
import { Bubble } from './Bubble'
import { CommandBar, CommandRail } from './CommandRail'
import { Working } from './Working'
import { commandToken, hideClaimed, toTurns, verbFor } from './turns'
import { filterSlash, slashQuery } from './slash'
import { annotate, collapse, lineDiff, summarise } from '../lib/lineDiff'
import { highlight, langOf, type Token } from '../lib/highlight'

// the command timeline down the right of the chat, and where its width is remembered
const RAIL_KEY = 'agent-fleet.commandRail'
const RAIL_MIN = 130

function readRail(): number {
  try {
    const v = Number(localStorage.getItem(RAIL_KEY))
    return v >= RAIL_MIN ? v : 190
  } catch {
    return 190
  }
}

export function ChatView({
  s,
  agent,
  now,
  onOpenTerminal
}: {
  s: Session
  agent: Agent | null
  now: number
  onOpenTerminal: () => void
}): JSX.Element {
  const turns = useMemo(() => toTurns(s.transcript), [s.transcript])
  const [pending, setPending] = useState<Array<{ id: string; ts: string; text: string }>>([])
  // A slash command is not a message, so it gets no echo bubble and no place in the conversation.
  // It is an interaction that happens in the terminal and leaves its own surface behind, which is
  // what `before` is for: the pty as it stood the instant the keystrokes went in.
  const [runs, setRuns] = useState<Array<{ id: string; ts: string; text: string; before: Promise<string> }>>([])
  // every command this view has sent, kept for as long as the view lives, so the transcript's own
  // record of one is recognised as ours however late it arrives
  const [claims, setClaims] = useState<Array<{ token: string; at: number }>>([])
  const [draft, setDraft] = useState('')

  // An echo lives until the same words show up in the transcript. Claude Code rewrites a pasted
  // block on the way in — newlines become spaces, and long text is cut short — so the match is made
  // on collapsed whitespace and a prefix, not on the exact characters.
  //
  // It used to expire after 30 seconds as well, which read as the app eating the message: Claude
  // Code sometimes writes no transcript file at all for minutes while it works, so the echo of a
  // prompt the pty had already accepted vanished and the chat went blank. The only honest reasons
  // to drop one are that it landed or that the process is gone; the half hour is a safety valve so
  // an echo that never matches cannot accumulate through a long session.
  useEffect(() => {
    if (!pending.length) return
    const flat = (t: string): string => t.replace(/\s+/g, ' ').trim()
    const said = s.transcript.filter((i) => i.kind === 'prompt' || i.kind === 'command').map((i) => flat(i.text))
    const now = Date.now()
    const gone = !!agent && agent.status === 'exited'
    const keep = pending.filter((p) => {
      const mine = flat(p.text)
      const head = mine.slice(0, 60)
      const landed = said.some((t) => t === mine || t.startsWith(head) || mine.startsWith(t.slice(0, 60)))
      return !landed && !gone && now - Date.parse(p.ts) < 30 * 60_000
    })
    if (keep.length !== pending.length) setPending(keep)
  }, [s.transcript, pending, agent?.status])
  // The last thing the session said of its own accord. What was sent to it does not count: an
  // Claude Code writes some slash commands to the transcript itself, and taking one of those for an
  // answer would close the terminal card the instant it opened.
  const lastSaid = useMemo(() => {
    for (let i = s.transcript.length - 1; i >= 0; i--) {
      const it = s.transcript[i]
      if (it.kind !== 'prompt' && it.kind !== 'command') return Date.parse(it.ts)
    }
    return 0
  }, [s.transcript])

  // A command that turns into real work is drawn by the chat itself, so the terminal card steps
  // aside rather than showing the same turn twice. The half hour is the same safety valve the
  // echoes have: a card that never resolves must not outlive the session.
  useEffect(() => {
    if (!runs.length) return
    const dead = !!agent && agent.status === 'exited'
    const keep = runs.filter((r) => !dead && lastSaid <= Date.parse(r.ts) && now - Date.parse(r.ts) < 30 * 60_000)
    if (keep.length !== runs.length) setRuns(keep)
  }, [runs, lastSaid, agent?.status, now])

  // Claude Code records some slash commands in the transcript and not others, and the chip it makes
  // is exactly the message the user asked never to see beside the surface. A claim outlives the card
  // that answered it, so the bubble cannot reappear once the card has finished or been pruned.
  const shown = useMemo(() => hideClaimed(turns, claims), [turns, claims])
  const box = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  // a command surface grows in place rather than by arriving, so it says when it has, or its
  // choices end up drawn below the fold and the menu reads as having none
  const [grew, setGrew] = useState(0)
  useEffect(() => {
    const el = box.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [turns, pending, runs, grew, stick])

  const live = !!agent && agent.status !== 'exited'
  // an agent that died before writing anything left its reason in the terminal, nowhere else
  const [deathNote, setDeathNote] = useState<string | null>(null)
  useEffect(() => {
    if (!agent || agent.status !== 'exited' || s.transcript.length) {
      setDeathNote(null)
      return
    }
    void window.api.pty.history(agent.id).then((h) => {
      const lines = h
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      setDeathNote(lines.slice(-6).join('\n') || null)
    })
  }, [agent?.id, agent?.status, s.transcript.length])
  const waiting = s.state === 'waiting'
  // Claude Code writes nothing until the first message, so an empty transcript is the normal state
  // of a session waiting for you, not a sign that something is wrong.
  const empty = !!agent && agent.status !== 'exited' && !s.transcript.length
  const startedFor = agent ? now - Date.parse(agent.createdAt) : 0
  const starting = empty && startedFor < 12_000
  // a session that has said nothing is not mid-turn, whatever the card's state says
  const busy = s.state === 'running' && !empty
  // the turn started at the last thing you said; that is the clock Claude Code shows too
  const turnStart = useMemo(() => {
    for (let i = s.transcript.length - 1; i >= 0; i--) {
      const it = s.transcript[i]
      if (it.kind === 'prompt' || it.kind === 'command') return Date.parse(it.ts)
    }
    return s.lastEventAt ? Date.parse(s.lastEventAt) : now
  }, [s.transcript, s.lastEventAt, now])

  // output tokens counted from the start of this turn, so the number means "produced just now"
  const baseOutput = useRef(0)
  const lastTurn = useRef(0)
  if (lastTurn.current !== turnStart) {
    lastTurn.current = turnStart
    baseOutput.current = s.tokens.output
  }

  // the review chain, in the order it runs
  // the user's own list, edited from the commands tab in the fleet view
  const QUICK = useQuick()

  // Esc is what Claude Code listens for; the terminal tab does this when you press it there
  function interrupt(): void {
    if (!agent) return
    window.api.pty.write(agent.id, '\x1b')
  }

  /**
   * Claude Code takes an image as a path in the prompt, so an attachment is a file plus a mention of
   * it. Pasting, dropping and picking all end the same way: the path is appended to the draft, and
   * the user can say what they want done with it before sending.
   */
  const [attaching, setAttaching] = useState(false)
  const openTools = useToolRows()
  // the slash menu: open whenever the draft is still just the command being typed
  const slashAll = useCatalogItems()
  const [slashAt, setSlashAt] = useState(0)
  // counts keyboard moves only, so the menu knows when to scroll and when to hold still
  const [slashKeyed, setSlashKeyed] = useState(0)
  const moveSlash = (step: number): void => {
    setSlashAt((i) => (i + step + slashList.length) % slashList.length)
    setSlashKeyed((n) => n + 1)
  }
  const query = slashQuery(draft)
  const slashList = useMemo(() => (query === null ? [] : filterSlash(slashAll, query)), [slashAll, query])
  const slashOpen = query !== null && slashList.length > 0
  useEffect(() => {
    setSlashAt(0)
    setSlashKeyed(0)
  }, [query])

  function pickSlash(index = slashAt): void {
    const item = slashList[Math.min(index, slashList.length - 1)]
    if (!item) return
    // a command that takes something keeps the composer open; one that does not is ready to send
    setDraft(`/${item.token}${item.hint ? ' ' : ' '}`)
  }
  const [railW, setRailW] = useState(readRail)
  // the rail is a column when the chat can spare one, and a line across the top when it cannot
  const [paneW, setPaneW] = useState(0)
  const pane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = pane.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setPaneW(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const railFits = paneW === 0 || paneW >= 720
  const railFrom = useRef(0)
  // what was attached, so the composer can show pictures instead of a wall of paths. The path still
  // goes into the draft: that is what Claude Code reads, and the user may want to edit around it.
  const [shots, setShots] = useState<Array<{ path: string; thumb: string | null }>>([])

  function mention(path: string): void {
    setDraft((d) => (d ? `${d.replace(/\s*$/, '')} ${path} ` : `${path} `))
    void window.api.files.imageThumb(path).then((thumb) => setShots((prev) => [...prev, { path, thumb }]))
  }

  function unmention(path: string): void {
    setDraft((d) => d.replace(path, '').replace(/[ \t]{2,}/g, ' ').trim())
    setShots((prev) => prev.filter((x) => x.path !== path))
  }

  useEffect(() => {
    setShots((prev) => {
      const kept = prev.filter((x) => draft.includes(x.path))
      return kept.length === prev.length ? prev : kept
    })
  }, [draft])

  async function attachFile(file: File): Promise<void> {
    setAttaching(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      mention(await window.api.files.saveImage(bytes, file.type || 'image/png'))
    } finally {
      setAttaching(false)
    }
  }

  /** The browser pane, as the agent would see it. Only works while that pane is actually on screen. */
  async function attachShot(): Promise<void> {
    if (!agent) return
    setAttaching(true)
    try {
      const shot = await window.api.browser.shot(agent.id)
      mention(shot)
    } catch (err) {
      setDraft((d) => d + (d ? ' ' : '') + `(could not capture the browser: ${err instanceof Error ? err.message : String(err)})`)
    } finally {
      setAttaching(false)
    }
  }

  function send(override?: string): void {
    const text = (override ?? draft).trim()
    if (!text || !agent) return
    const ts = new Date().toISOString()
    if (text.startsWith('/')) {
      // The screen the command started from has to be read before the keystrokes go in: /skills
      // answers instantly, and a screen sampled once the card has mounted already has the answer
      // on it, so nothing about it would look new.
      const before = window.api.pty.history(agent.id).catch(() => '')
      setRuns((r) => [...r, { id: `run-${Date.now()}`, ts, text, before }])
      setClaims((c) => [...c, { token: commandToken(text), at: Date.parse(ts) }])
    } else {
      // the transcript is written in bursts, so a sent message would sit invisible for a second or
      // two; show it at once and drop the echo when the real one arrives
      setPending((p) => [...p, { id: `pending-${Date.now()}`, ts, text }])
    }
    // A slash command opens Claude Code's command menu while it is being typed, and a return that
    // arrives before the menu has settled picks the highlighted entry instead of sending the line —
    // which is how "/commit skip" went in as "/commit" and then again in full. Plain text for a
    // single line, bracketed paste only when newlines have to survive, and enough delay either way.
    //
    // The delay is a measured guess, not a signal: nothing the pty emits says "the menu has
    // settled", so a machine slow enough could still race. If Claude Code ever exposes that state,
    // through a hook or an escape sequence, wait on it instead of a number.
    const multiline = text.includes('\n')
    window.api.pty.write(agent.id, multiline ? `\x1b[200~${text}\x1b[201~` : text)
    setTimeout(() => window.api.pty.write(agent.id, '\r'), multiline ? 80 : 220)
    if (!override) setDraft('')
    setStick(true)
  }

  return (
    <div ref={pane} className="flex h-full min-w-0 bg-[var(--ink)]">
      <div className="flex min-w-0 flex-1 flex-col">
        {!railFits && !!s.commands.length && <CommandBar list={s.commands} now={now} />}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
        }}
        className="select min-h-0 flex-1 overflow-auto px-5 py-4"
      >
        {shown.map((t) => (
          <Bubble key={t.id} t={t} agentId={agent?.id ?? null} cwd={s.cwd} openTools={openTools} />
        ))}
        {!shown.length && !runs.length && !busy && !starting && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] text-[var(--dim)]">
            <span className="text-[var(--muted)]">{empty ? 'session ready' : 'nothing said yet'}</span>
            {empty && <span>type below, or press the terminal tab to use Claude Code directly</span>}
          </div>
        )}
        {/* echoes and command surfaces are two lists, so they are put back in the order they were
            sent; a surface belongs where its command was typed, not at the end of the log */}
        {[
          ...pending.map((p) => ({
            ts: p.ts,
            node: (
              <Bubble
                key={p.id}
                t={{ id: p.id, role: 'you', ts: p.ts, text: p.text, command: p.text.startsWith('/'), tools: [] }}
                agentId={agent?.id ?? null}
                cwd={s.cwd}
                openTools={openTools}
              />
            )
          })),
          ...(agent
            ? runs.map((r) => ({
                ts: r.ts,
                node: (
                  <SlashRunCard
                    key={r.id}
                    agentId={agent.id}
                    command={r.text}
                    before={r.before}
                    onOpenTerminal={onOpenTerminal}
                    onGone={() => setRuns((list) => list.filter((x) => x.id !== r.id))}
                    onGrow={() => setGrew((n) => n + 1)}
                  />
                )
              }))
            : [])
        ]
          .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
          .map((x) => x.node)}
        {(waiting || empty) && agent && (
          <ApprovalCard agentId={agent.id} quiet={!waiting} onOpenTerminal={onOpenTerminal} />
        )}
      </div>

      {/* pinned above the composer: scrolling back through the conversation must not hide the fact
          that the session is still working */}
      {(busy || waiting || starting) && (
        <div className="shrink-0 border-t border-[var(--line)] px-4 pb-1 pt-2.5">
          <Working
            tool={s.currentTool}
            elapsed={now - turnStart}
            produced={Math.max(0, s.tokens.output - baseOutput.current)}
            verb={starting ? 'Starting Claude Code' : verbFor(turnStart)}
            waiting={waiting}
            sub={s.origin === 'subagent'}
            onInterrupt={agent && !waiting ? () => interrupt() : undefined}
          />
        </div>
      )}

      <div className={`shrink-0 px-4 py-3 ${busy || waiting || starting ? '' : 'border-t border-[var(--line)]'}`}>
        {live ? (
          <>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {QUICK.map((cmd) => (
              <button
                key={cmd}
                onClick={() => send(cmd)}
                title={`send ${cmd} to this session`}
                className="mono rounded border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--muted)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
              >
                {cmd}
              </button>
            ))}
            <button
              onClick={() => send('/clear')}
              title="clear this conversation"
              className="mono ml-auto rounded border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--muted)] hover:border-[var(--danger)]/50 hover:text-[var(--danger)]"
            >
              /clear
            </button>
          </div>
          {slashOpen && (
            <SlashMenu
              items={slashList}
              index={slashAt}
              keyed={slashKeyed}
              onPick={(it) => pickSlash(slashList.indexOf(it))}
              onHover={setSlashAt}
            />
          )}
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel)] focus-within:border-[var(--accent)]">
            {!!shots.length && (
              <div className="flex flex-wrap gap-2 px-3 pt-2.5">
                {shots.map((sh) => (
                  <span
                    key={sh.path}
                    title={sh.path}
                    className="group relative overflow-hidden rounded border border-[var(--line)] bg-[var(--raised)]"
                  >
                    {sh.thumb ? (
                      <img src={sh.thumb} alt="" className="block h-10 w-auto max-w-[120px] object-cover" />
                    ) : (
                      <span className="mono block px-2 py-2.5 text-[10px] text-[var(--muted)]">
                        {sh.path.split('/').pop()}
                      </span>
                    )}
                    <button
                      onClick={() => unmention(sh.path)}
                      title="remove this attachment"
                      className="absolute right-0 top-0 hidden h-4 w-4 items-center justify-center bg-[var(--ink)]/80 text-[10px] leading-none text-[var(--danger)] group-hover:flex"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const image = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
                if (!image) return
                e.preventDefault()
                void attachFile(image)
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const image = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
                if (!image) return
                e.preventDefault()
                void attachFile(image)
              }}
              onKeyDown={(e) => {
                if (slashOpen) {
                  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
                    e.preventDefault()
                    moveSlash(1)
                    return
                  }
                  if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                    e.preventDefault()
                    moveSlash(-1)
                    return
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    // One press, the way the terminal takes it. Enter used to always complete, so a
                    // name that was already complete cost two presses to send. It completes a
                    // half-typed name and sends a finished one; moving the highlight off an exact
                    // match makes it a half-typed name again, which is what moving it meant.
                    if (draft.slice(1) === slashList[slashAt]?.token) send()
                    else pickSlash()
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setDraft('')
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
                  e.preventDefault()
                  send()
                }
                // esc clears a draft first, and interrupts the turn when there is nothing to clear
                if (e.key === 'Escape') {
                  e.preventDefault()
                  if (draft) setDraft('')
                  else if (busy) interrupt()
                }
              }}
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              placeholder={`message ${s.topic ?? s.repo}…`}
              className="select w-full resize-none bg-transparent px-3 py-2.5 text-[12.5px] outline-none placeholder:text-[var(--dim)]"
            />
            <div className="flex items-center gap-3 px-3 pb-2">
              <span className="lbl">↩ send · ⇧↩ newline</span>
              <button
                onClick={() => void window.api.files.pickImage().then((p) => p && mention(p))}
                disabled={attaching}
                title="attach an image; paste or drop one here too"
                className="lbl hover:!text-[var(--accent)] disabled:opacity-40"
              >
                {attaching ? 'attaching…' : '+ image'}
              </button>
              {agent && (
                <button
                  onClick={() => void attachShot()}
                  disabled={attaching}
                  title="attach a shot of this agent's browser pane, which must be open to capture"
                  className="lbl hover:!text-[var(--accent)] disabled:opacity-40"
                >
                  + browser shot
                </button>
              )}
              <button
                onClick={toggleToolRows}
                role="switch"
                aria-checked={openTools}
                title={
                  openTools
                    ? 'on: every diff and command output is shown without clicking'
                    : 'off: tool calls stay collapsed until you open one'
                }
                className="ml-auto flex items-center gap-1.5 hover:opacity-90"
              >
                <span className="lbl">auto-expand tool calls</span>
                <span
                  className="relative block h-[13px] w-[24px] rounded-full transition-colors"
                  style={{
                    background: openTools ? 'var(--accent)' : 'var(--raised)',
                    boxShadow: openTools ? 'none' : 'inset 0 0 0 1px var(--line)'
                  }}
                >
                  <span
                    className="absolute top-[2px] block h-[9px] w-[9px] rounded-full transition-all"
                    style={{
                      left: openTools ? '13px' : '2px',
                      background: openTools ? 'var(--ink)' : 'var(--muted)'
                    }}
                  />
                </span>
              </button>
              <button
                onClick={() => send()}
                disabled={!draft.trim()}
                className="rounded bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--ink)] disabled:opacity-30"
              >
                send
              </button>
            </div>
          </div>
          </>
        ) : (
          <div className="text-[11px] text-[var(--dim)]">
            {agent ? (
              <div className="flex flex-col gap-2">
                <span>
                  this agent is not running
                  {deathNote ? ' · it stopped before saying anything' : ' · resume it to keep talking'}
                </span>
                {deathNote && (
                  <pre className="select mono max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--danger)]/40 bg-[var(--panel)] px-2.5 py-2 text-[10px] leading-snug text-[var(--danger)]">
                    {deathNote}
                  </pre>
                )}
                <span className="flex gap-2">
                  <button
                    onClick={() => {
                      const { cols, rows } = termSize()
                      void window.api.agents.resumeAgent(agent.id, cols, rows)
                    }}
                    className="chip chip-running hover:brightness-110"
                  >
                    {agent.cwd ? 'resume' : 'start again'}
                  </button>
                  <button onClick={() => void window.api.agents.removeAgent(agent.id)} className="chip hover:!text-[var(--danger)]">
                    remove
                  </button>
                </span>
              </div>
            ) : (
              'started in a terminal, so this view is read-only · reply in its own window'
            )}
          </div>
        )}
      </div>
      </div>
      {railFits && !!s.commands.length && (
        <>
          <Divider
            onStart={() => (railFrom.current = railW)}
            onDrag={(d) => setRailW(Math.min(360, Math.max(RAIL_MIN, railFrom.current - d)))}
            onEnd={() => {
              try {
                localStorage.setItem(RAIL_KEY, String(railW))
              } catch {
                // storage unavailable; the width just does not persist
              }
            }}
            title="drag to resize the command timeline"
          />
          <CommandRail list={s.commands} now={now} width={railW} />
        </>
      )}
    </div>
  )
}

/**
 * The session's slash commands, as a timeline down the side of the chat.
 *
 * Oldest at the top, newest at the bottom, the same direction the conversation runs, so the two read
 * together. The gap printed under each entry is the time since the one before it, which is what turns
 * a list of names into the shape of a review loop: a long gap is work, a short one is a retry.
 */
