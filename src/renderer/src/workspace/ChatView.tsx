import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, Session, TranscriptItem } from '../../../shared/types'
import { clock, dur, tokens as fmtTokens } from '../lib/format'
import { Markdown } from './Markdown'
import { useCountUp } from '../lib/useCountUp'
import { ApprovalCard } from './Approval'
import { termSize } from '../terminal/Terminal'

interface Turn {
  id: string
  role: 'you' | 'claude'
  ts: string
  text: string
  command?: boolean
  tools: Array<{ id: string; tool: string; text: string; result?: TranscriptItem }>
}

// one word per turn, picked from the turn's own start time so it holds still while the turn runs
const VERBS = [
  'Baking', 'Germinating', 'Percolating', 'Simmering', 'Noodling', 'Cogitating', 'Whirring', 'Pondering',
  'Brewing', 'Tinkering', 'Rummaging', 'Puttering', 'Chewing', 'Untangling', 'Kneading', 'Distilling',
  'Marinating', 'Spelunking', 'Shuffling', 'Conjuring', 'Sifting', 'Plotting', 'Wrangling', 'Composing',
  'Ruminating', 'Assembling', 'Polishing', 'Foraging', 'Weaving', 'Calibrating'
]

function verbFor(seed: number): string {
  return VERBS[Math.abs(Math.floor(seed / 1000)) % VERBS.length]
}

/** the transcript is a flat log; a chat needs it grouped into turns with tools folded in */
export function toTurns(items: TranscriptItem[]): Turn[] {
  const out: Turn[] = []
  // every tool call so far, by its tool_use id. Results for a batch of calls all arrive in one user
  // message and can answer a call from an earlier turn, so the lookup has to outlive `cur`.
  const byToolUseId = new Map<string, Turn['tools'][number]>()
  let cur: Turn | null = null
  for (const it of items) {
    if (it.kind === 'prompt' || it.kind === 'command') {
      cur = null
      out.push({ id: it.id, role: 'you', ts: it.ts, text: it.text, command: it.kind === 'command', tools: [] })
      continue
    }
    if (it.kind === 'text') {
      cur = { id: it.id, role: 'claude', ts: it.ts, text: it.text, tools: [] }
      out.push(cur)
      continue
    }
    if (it.kind === 'tool') {
      if (!cur || cur.role !== 'claude') {
        cur = { id: it.id, role: 'claude', ts: it.ts, text: '', tools: [] }
        out.push(cur)
      }
      const call = { id: it.id, tool: it.tool ?? 'tool', text: it.text }
      cur.tools.push(call)
      if (it.toolUseId) byToolUseId.set(it.toolUseId, call)
      continue
    }
    if (it.kind === 'result') {
      // an item parsed before toolUseId existed carries no id, so it keeps the old last-tool pairing
      const call = it.toolUseId ? byToolUseId.get(it.toolUseId) : cur?.tools[cur.tools.length - 1]
      // a result whose call has already fallen out of the transcript ring has nowhere to go, and
      // hanging it on an unrelated call would show the wrong output under it
      if (call && !call.result) call.result = it
    }
  }
  return out
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
  const box = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  useEffect(() => {
    const el = box.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [turns, pending, stick])

  const live = !!agent && agent.status !== 'exited'
  // an agent that died before writing anything left its reason in the terminal, nowhere else
  const [deathNote, setDeathNote] = useState<string | null>(null)
  useEffect(() => {
    if (!agent || agent.status !== 'exited' || s.transcript.length) {
      setDeathNote(null)
      return
    }
    void window.api.ptyHistory(agent.id).then((h) => {
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
  const QUICK = ['/git-add', '/preflight', '/fix-issues', '/commit', '/commit skip']

  // Esc is what Claude Code listens for; the terminal tab does this when you press it there
  function interrupt(): void {
    if (!agent) return
    window.api.ptyWrite(agent.id, '\x1b')
  }

  function send(override?: string): void {
    const text = (override ?? draft).trim()
    if (!text || !agent) return
    // the transcript is written in bursts, so a sent message would sit invisible for a second or
    // two; show it at once and drop the echo when the real one arrives
    setPending((p) => [...p, { id: `pending-${Date.now()}`, ts: new Date().toISOString(), text }])
    // A slash command opens Claude Code's command menu while it is being typed, and a return that
    // arrives before the menu has settled picks the highlighted entry instead of sending the line —
    // which is how "/commit skip" went in as "/commit" and then again in full. Plain text for a
    // single line, bracketed paste only when newlines have to survive, and enough delay either way.
    const multiline = text.includes('\n')
    window.api.ptyWrite(agent.id, multiline ? `\x1b[200~${text}\x1b[201~` : text)
    setTimeout(() => window.api.ptyWrite(agent.id, '\r'), multiline ? 80 : 220)
    if (!override) setDraft('')
    setStick(true)
  }

  return (
    <div className="flex h-full flex-col bg-[var(--ink)]">
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
        }}
        className="select min-h-0 flex-1 overflow-auto px-5 py-4"
      >
        {turns.map((t) => (
          <Bubble key={t.id} t={t} agentId={agent?.id ?? null} />
        ))}
        {!turns.length && !busy && !starting && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] text-[var(--dim)]">
            <span className="text-[var(--muted)]">{empty ? 'session ready' : 'nothing said yet'}</span>
            {empty && <span>type below, or press the terminal tab to use Claude Code directly</span>}
          </div>
        )}
        {pending.map((p) => (
          <Bubble
            key={p.id}
            t={{ id: p.id, role: 'you', ts: p.ts, text: p.text, command: p.text.startsWith('/'), tools: [] }}
            agentId={agent?.id ?? null}
          />
        ))}
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
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel)] focus-within:border-[var(--accent)]">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
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
              <span className="lbl ml-auto">typed straight into the session</span>
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
                      void window.api.resumeAgent(agent.id, cols, rows)
                    }}
                    className="chip chip-running hover:brightness-110"
                  >
                    {agent.cwd ? 'resume' : 'start again'}
                  </button>
                  <button onClick={() => void window.api.removeAgent(agent.id)} className="chip hover:!text-[var(--danger)]">
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
  )
}

function Working({
  tool,
  elapsed,
  produced,
  verb,
  waiting,
  sub,
  onInterrupt
}: {
  tool: string | null
  elapsed: number
  produced: number
  verb: string
  waiting: boolean
  sub: boolean
  onInterrupt?: () => void
}): JSX.Element {
  const color = waiting ? 'var(--warn)' : sub ? 'var(--sub)' : 'var(--accent)'
  const shown = useCountUp(produced)
  return (
    <div>
      <div className="flex items-center gap-2 text-[11.5px]" style={{ color }}>
      <span className={waiting ? 'dot-blink' : 'node-breathe'} style={{ fontSize: 13 }}>
        ✶
      </span>
      <span>{waiting ? 'Waiting for your approval' : `${verb}…`}</span>
      <span className="mono text-[10px] text-[var(--dim)]">
        ({dur(elapsed)}
        {shown > 0 ? ` · ↓ ${fmtTokens(shown)} tokens` : ''})
      </span>
      {tool && !waiting && <span className="mono text-[10px] text-[var(--muted)]">{tool}</span>}
        {!waiting && (
          <span className="flex gap-[3px]">
            <Dot delay={0} />
            <Dot delay={0.18} />
            <Dot delay={0.36} />
          </span>
        )}
        {onInterrupt && (
          <button
            onClick={onInterrupt}
            title="interrupt this turn (esc)"
            className="mono ml-auto rounded border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--danger)]/50 hover:text-[var(--danger)]"
          >
            interrupt · esc
          </button>
        )}
      </div>
      <div
        className={`work-track mt-2 h-[3px] w-full rounded-full ${
          waiting ? 'work-track-wait' : sub ? 'work-track-sub' : ''
        }`}
      />
    </div>
  )
}

function Dot({ delay }: { delay: number }): JSX.Element {
  return (
    <span
      className="node-breathe inline-block h-[3px] w-[3px] rounded-full bg-current"
      style={{ animationDelay: `${delay}s`, animationDuration: '1.2s' }}
    />
  )
}

function Bubble({ t, agentId }: { t: Turn; agentId: string | null }): JSX.Element {
  if (t.role === 'you') {
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-[var(--accent-soft)] px-3.5 py-2.5">
          <div className="mono mb-1 text-[9px] uppercase tracking-widest text-[var(--accent)]">you · {clock(t.ts)}</div>
          {t.command ? (
            <div className="mono text-[12px] text-[var(--fg)]">{t.text}</div>
          ) : (
            <div className="select text-[12.5px] leading-relaxed">
              <Markdown text={t.text} agentId={agentId} />
            </div>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="mb-4 max-w-[92%]">
      <div className="mono mb-1 text-[9px] uppercase tracking-widest text-[var(--dim)]">claude · {clock(t.ts)}</div>
      {t.text && (
        <div className="select text-[12.5px] leading-relaxed text-[var(--fg)]/90">
          <Markdown text={t.text} agentId={agentId} />
        </div>
      )}
      {t.tools.map((tool) => (
        <ToolLine key={tool.id} tool={tool} />
      ))}
    </div>
  )
}

function ToolLine({ tool }: { tool: { tool: string; text: string; result?: TranscriptItem } }): JSX.Element {
  const [open, setOpen] = useState(false)
  const err = tool.result?.isError
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="mono flex w-full items-baseline gap-2 rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-left text-[10.5px] hover:border-[var(--muted)]"
      >
        <span className={err ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}>{open ? '▾' : '▸'} {tool.tool}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]" title={tool.text}>
          {tool.text}
        </span>
        {!tool.result && <span className="shrink-0 text-[var(--accent)]">running</span>}
      </button>
      {open && tool.result && (
        <pre className="select mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-[10px] leading-snug text-[var(--muted)]">
          {tool.result.text || '(no output)'}
        </pre>
      )}
    </div>
  )
}
