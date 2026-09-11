import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Agent, Session } from '../../../shared/types'
import { age, shortModel, tokens } from '../lib/format'
import { Waterfall } from './Waterfall'
import { Terminal, termSize } from '../terminal/Terminal'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { Divider } from '../lib/Divider'
import { usePersisted } from '../state/persist'

const label: Record<Session['state'], string> = {
  running: 'running',
  waiting: 'waiting for you',
  idle: 'idle',
  stale: 'stale',
  ended: 'ended'
}
const color: Record<Session['state'], string> = {
  running: 'text-[var(--accent)]',
  waiting: 'text-[var(--warn)]',
  idle: 'text-[var(--muted)]',
  stale: 'text-[var(--dim)]',
  ended: 'text-[var(--dim)]'
}

type View = 'chat' | 'terminal'

const TIMELINE_KEY = 'agent-fleet.timelineHeight'
// The compact height: one row of dots plus its heading. Dragging below the old floor lands here, so
// a short pane becomes a strip rather than a squeezed set of lanes.
const TIMELINE_COMPACT = 46
const TIMELINE_MIN = 96
const TERMINAL_MIN = 160
const BROWSER_KEY = 'agent-fleet.browserWidth'
const BROWSER_MIN = 320
const AGENT_MIN = 380

function readTimelineHeight(): number {
  try {
    const v = Number(localStorage.getItem(TIMELINE_KEY))
    if (v >= TIMELINE_COMPACT) return v
  } catch {
    // storage unavailable
  }
  return 132
}

function readBrowserWidth(): number {
  try {
    const v = Number(localStorage.getItem(BROWSER_KEY))
    if (v >= BROWSER_MIN) return v
  } catch {
    // storage unavailable
  }
  return 620
}

export function Workspace({ s, agent, now }: { s: Session | null; agent: Agent | null; now: number }): JSX.Element {
  // Not persisted on purpose: every agent records how it was launched, and the effect below applies
  // that on open. A remembered view would be overwritten a frame later, which is worse than no
  // memory at all.
  const [view, setView] = useState<View>('chat')
  // each agent remembers how it was launched; opening another one honours its own choice
  useEffect(() => {
    if (!agent) return
    setView(agent.chat === false ? 'terminal' : 'chat')
  }, [agent?.id, agent?.chat])
  // whether the right panel is showing at all, which is a working preference rather than a per-agent one
  const [browserOn, setBrowserOn] = usePersisted<boolean>('rightPanelOpen', true)
  const [browserWidth, setBrowserWidth] = useState(readBrowserWidth)
  const [timelineH, setTimelineH] = useState(readTimelineHeight)
  // the height to come back to when the strip is toggled off again
  const lastTimeline = useRef(Math.max(TIMELINE_MIN, readTimelineHeight()))
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [boxH, setBoxH] = useState(0)
  // sizes at the moment a drag begins, so the handle moves with the pointer instead of jumping
  const dragFrom = useRef({ browser: 0, timeline: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      setWidth(e.contentRect.width)
      setBoxH(e.contentRect.height)
    })
    ro.observe(el)
    const box = el.getBoundingClientRect()
    setWidth(box.width)
    setBoxH(box.height)
    return () => ro.disconnect()
  }, [])
  if (!s) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--dim)]">
        <span>pick a node</span>
        <span className="text-[11px]">⌘N for a new agent</span>
      </div>
    )
  }
  const total = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite
  // a watched session has no pty, so its chat is read-only and the terminal tab is meaningless
  const showTerminal = !!agent && view === 'terminal'
  // the browser needs real estate; below this the agent pane keeps it all
  // the panel holds git as well as the browser, so it is useful even for a watched session
  const showPanel = browserOn && width >= BROWSER_MIN + AGENT_MIN
  // the pane is anchored to the right edge, so the divider position is measured from there
  const dragBrowser = (delta: number): void => {
    const max = Math.max(BROWSER_MIN, width - AGENT_MIN)
    setBrowserWidth(Math.min(max, Math.max(BROWSER_MIN, dragFrom.current.browser - delta)))
  }
  // the timeline grows upward from the bottom edge, so the drag reads from that edge
  const dragTimeline = (delta: number): void => {
    const max = Math.max(TIMELINE_MIN, boxH - TERMINAL_MIN)
    const want = dragFrom.current.timeline - delta
    // Between the compact height and the height the lanes need there is nothing worth drawing, so
    // the handle snaps past it: drag it small and it becomes the strip on its own.
    const snapped = want < TIMELINE_MIN - 12 ? TIMELINE_COMPACT : Math.max(TIMELINE_MIN, want)
    setTimelineH(Math.min(max, snapped))
  }

  /** Double click is the toggle: down to the strip, and back to whatever height it had before. */
  const toggleTimeline = (): void => {
    setTimelineH((h) => {
      if (h > TIMELINE_COMPACT) {
        lastTimeline.current = h
        return TIMELINE_COMPACT
      }
      return lastTimeline.current
    })
    // the next paint carries the new height; persist from there rather than from the stale value
    requestAnimationFrame(persistTimeline)
  }
  const persistTimeline = (): void => {
    try {
      localStorage.setItem(TIMELINE_KEY, String(timelineH))
    } catch {
      // storage unavailable
    }
  }
  const persistBrowser = (): void => {
    try {
      localStorage.setItem(BROWSER_KEY, String(browserWidth))
    } catch {
      // storage unavailable
    }
  }
  return (
    <div ref={ref} className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col bg-[var(--ink)]">
      <header className="flex shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-b border-[var(--line)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <StateDot state={s.state} exited={agent?.status === 'exited'} />
          <span className="mono flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--muted)]">
            {s.worktree && (
              <span className="lbl rounded bg-[var(--raised)] px-1 py-0.5" title="runs in its own git worktree, isolated from your checkout">
                worktree
              </span>
            )}
            {s.branch ?? '—'}
          </span>
          {agent?.detached && (
          <span className="chip shrink-0" title="runs in tmux; closing the app leaves it running">
            detached
          </span>
        )}
        {s.lastCommand && (
            <span className="mono shrink-0 rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10.5px]">{s.lastCommand}</span>
          )}
        </div>

        <span className={`shrink-0 text-[11.5px] ${color[s.state]}`}>
          {agent?.status === 'exited'
            ? `exited${agent.exitCode ? ` (${agent.exitCode})` : ''}`
            : s.state === 'running' && s.currentTool
              ? `▸ ${s.currentTool}`
              : label[s.state]}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {agent && <Segmented value={view} onChange={setView} options={['chat', 'terminal']} />}
          <button
            onClick={() => setBrowserOn(!browserOn)}
            title="browser and git panel"
            className={`rounded border px-2 py-1 text-[11px] ${
              browserOn
                ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--fg)]'
            }`}
          >
            panel
          </button>
          {agent && <AgentControls agent={agent} />}
        </div>
      </header>
      <div className="mono flex shrink-0 items-center gap-6 overflow-hidden whitespace-nowrap border-b border-[var(--line)] px-5 py-2 text-[10.5px] text-[var(--muted)]">
        <Stat k="kind" v={s.origin === 'subagent' ? (s.agentType ?? 'subagent') : s.origin === 'app' ? 'launched here' : 'from terminal'} />
        <Stat k="model" v={shortModel(s.model)} />
        <Stat k="turns" v={String(s.turns)} />
        <Stat k="tokens" v={tokens(total)} />
        <Stat k="out" v={tokens(s.tokens.output)} />
        <Stat k="ctx" v={s.context ? tokens(s.context) : '—'} />
        <Stat k="last" v={age(s.lastEventAt, now)} />
        <Stat k="since" v={age(s.firstEventAt, now)} />
        <span className="ml-auto min-w-0 truncate text-[var(--dim)]" title={s.cwd}>{s.cwd}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {showTerminal ? (
          <Terminal id={agent.id} />
        ) : (
          // keyed per session: the composer's draft and its unsent echoes are that session's, and
          // without this React keeps one instance across a switch, so both follow you to the next
          // agent and a draft typed for one ends up written into another one's pty
          <ChatView key={s.id} s={s} agent={agent} now={now} onOpenTerminal={() => setView('terminal')} />
        )}
        {agent?.status === 'exited' && showTerminal && <ExitedPanel agent={agent} />}
      </div>
      <Divider
        axis="y"
        onStart={() => (dragFrom.current.timeline = timelineH)}
        onDrag={dragTimeline}
        onEnd={persistTimeline}
        onDoubleClick={toggleTimeline}
        title="drag to resize · double click for the compact strip"
      />
      <div className="shrink-0 pb-3" style={{ height: Math.min(timelineH, Math.max(TIMELINE_MIN, boxH - TERMINAL_MIN)) }}>
        <Waterfall sessionId={s.id} items={s.transcript} now={now} height={Math.min(timelineH, Math.max(TIMELINE_MIN, boxH - TERMINAL_MIN))} />
      </div>
      </div>
      {showPanel && (
        <>
          <Divider
            onStart={() => (dragFrom.current.browser = browserWidth)}
            onDrag={dragBrowser}
            onEnd={persistBrowser}
            title="drag to resize the panel"
          />
          <div className="flex min-w-0 shrink-0" style={{ width: Math.min(browserWidth, Math.max(BROWSER_MIN, width - AGENT_MIN)) }}>
            <RightPanel s={s} agent={agent} width={Math.min(browserWidth, Math.max(BROWSER_MIN, width - AGENT_MIN))} />
          </div>
        </>
      )}
    </div>
  )
}


function ExitedPanel({ agent }: { agent: Agent }): JSX.Element {
  const failed = agent.exitCode !== null && agent.exitCode !== 0
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-6">
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--raised)] px-4 py-2.5 text-[12px] shadow-xl">
        <span className={failed ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}>
          {failed ? `Claude exited with code ${agent.exitCode}. Output above says why.` : 'This agent is not running.'}
        </span>
        <button
          className="rounded bg-[var(--accent)] px-2.5 py-1 font-medium text-[var(--ink)]"
          onClick={() => {
            const { cols, rows } = termSize()
            void window.api.agents.resumeAgent(agent.id, cols, rows)
          }}
        >
          {agent.cwd ? 'resume' : 'start'}
        </button>
        <button className="rounded px-2 py-1 text-[var(--muted)] hover:text-[var(--fg)]" onClick={() => void window.api.agents.removeAgent(agent.id)}>
          remove
        </button>
      </div>
    </div>
  )
}

function Segmented({
  value,
  onChange,
  options
}: {
  value: View
  onChange: (v: View) => void
  options: View[]
}): JSX.Element {
  return (
    <span className="flex overflow-hidden rounded border border-[var(--line)]">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`px-2.5 py-1 text-[11px] ${
            value === o ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--fg)]'
          }`}
        >
          {o}
        </button>
      ))}
    </span>
  )
}

function StateDot({ state, exited }: { state: Session['state']; exited: boolean }): JSX.Element {
  const c = exited ? 'var(--danger)' : state === 'running' ? 'var(--accent)' : state === 'waiting' ? 'var(--warn)' : 'var(--muted)'
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${state === 'running' ? 'node-breathe' : state === 'waiting' ? 'dot-blink' : ''}`}
      style={{ background: c, boxShadow: state === 'running' || state === 'waiting' ? `0 0 8px ${c}` : undefined }}
    />
  )
}

// the actions that change the agent itself, grouped away from the views that only change what you look at
function AgentControls({ agent }: { agent: Agent }): JSX.Element {
  const btn = 'rounded border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--fg)]'
  return (
    <span className="flex items-center gap-1.5">
      {agent.status === 'exited' ? (
        <>
          <button
            className={`${btn} !border-[var(--accent)]/40 !text-[var(--accent)]`}
            onClick={() => {
              const { cols, rows } = termSize()
              void window.api.agents.resumeAgent(agent.id, cols, rows)
            }}
          >
            {agent.cwd ? 'resume' : 'start'}
          </button>
          <button className={`${btn} hover:!text-[var(--danger)]`} onClick={() => void window.api.agents.removeAgent(agent.id)}>
            remove
          </button>
        </>
      ) : (
        <button className={`${btn} hover:!text-[var(--danger)]`} onClick={() => void window.api.agents.stopAgent(agent.id)}>
          stop
        </button>
      )}
      <button className={btn} title={agent.repoPath} onClick={() => void window.api.shell.openPath(agent.cwd ?? agent.repoPath)}>
        folder
      </button>
    </span>
  )
}

function Stat({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <span className="flex flex-col">
      <span className="lbl">{k}</span>
      <span className="text-[var(--fg)]">{v}</span>
    </span>
  )
}
