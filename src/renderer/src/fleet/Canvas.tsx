import { useEffect, useMemo, useState } from 'react'
import type { Session } from '../../../shared/types'
import { age, tokens } from '../lib/format'
import { buildGraph, CARD_H, CARD_W, edgePath, REPO_H, REPO_W } from './graph'
import { repoColor } from '../lib/repoColor'
import { ColorPicker } from './ColorPicker'
import { useFlagged } from '../state/attention'
import { useDirty, type Dirty } from '../state/dirty'

interface Props {
  sessions: Session[]
  selected: string | null
  now: number
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}

// subtrees are open by default; the badge collapses them
function autoExpanded(sessions: Session[]): Set<string> {
  const out = new Set<string>()
  for (const s of sessions) {
    if (!s.parentId) continue
    if (s.parentAgentId) out.add(s.parentAgentId)
    out.add(s.parentId)
  }
  return out
}

export function Canvas({ sessions, selected, now, onSelect, onOpen }: Props): JSX.Element {
  const flagged = useFlagged()
  const dirty = useDirty(sessions)
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [picker, setPicker] = useState<string | null>(null)
  // repaint when a colour is chosen, since the mapping lives outside React
  const [, bump] = useState(0)
  useEffect(() => {
    const h = (): void => bump((n) => n + 1)
    window.addEventListener('agent-fleet:repo-colors', h)
    return () => window.removeEventListener('agent-fleet:repo-colors', h)
  }, [])
  const expanded = useMemo(() => {
    const auto = autoExpanded(sessions)
    for (const [id, on] of Object.entries(toggled)) {
      if (on) auto.add(id)
      else auto.delete(id)
    }
    return auto
  }, [sessions, toggled])
  const g = useMemo(() => buildGraph(sessions, expanded), [sessions, expanded])
  const toggle = (id: string): void => setToggled((t) => ({ ...t, [id]: !expanded.has(id) }))
  if (!sessions.length) {
    return <div className="flex h-full items-center justify-center text-[12px] text-[var(--dim)]">no sessions match</div>
  }
  return (
    <div className="h-full w-full overflow-auto overscroll-contain">
      <div className="relative" style={{ width: g.width, height: g.height, minWidth: '100%' }}>
        <svg className="absolute inset-0" width={g.width} height={g.height}>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--muted)" />
            </marker>
          </defs>
          {g.edges.map((e) => {
            const hot = selected !== null && e.id.endsWith(`→${selected}`)
            const owner = g.repos.find((r) => e.id.startsWith(`${r.key}→`))
            const tint = owner ? repoColor(owner.path) : 'var(--line)'
            return (
              <path
                key={e.id}
                d={edgePath(e)}
                fill="none"
                stroke={tint}
                strokeOpacity={hot ? 0.95 : owner ? 0.45 : 0.6}
                strokeWidth={1}
                markerEnd="url(#arrow)"
              />
            )
          })}
        </svg>
        {g.repos.map((r) => {
          const tint = repoColor(r.path)
          return (
            <div
              key={r.key}
              className="card absolute flex cursor-pointer flex-col justify-center overflow-visible px-3"
              style={{
                left: r.x,
                top: r.y,
                width: REPO_W,
                height: REPO_H,
                borderColor: `${tint}66`,
                // the agent cards come later in the DOM, so this has to be lifted to open over them
                zIndex: picker === r.path ? 60 : undefined
              }}
              onClick={() => setPicker(picker === r.path ? null : r.path)}
              title="click to change this repo's colour"
            >
              <span className="absolute inset-y-0 left-0 w-[3px] rounded-l" style={{ background: tint }} />
              <div className="lbl">repo</div>
              <div className="mono truncate text-[12px] font-medium" style={{ color: tint }} title={r.path}>
                {r.name}
              </div>
              {picker === r.path && <ColorPicker repoPath={r.path} onClose={() => setPicker(null)} />}
            </div>
          )
        })}
        {g.nodes.map((n) => (
          <SessionCard
            key={n.s.id}
            n={n.s}
            x={n.x}
            y={n.y}
            now={now}
            selected={n.s.id === selected}
            tint={repoColor(n.s.repoPath)}
            unread={flagged.get(n.s.id) ?? null}
            // a subagent works in its parent's checkout, so the same open files on its card would
            // read as a second pile of uncommitted work
            dirty={n.s.parentId ? null : (dirty.get(n.s.cwd) ?? null)}
            childCount={n.childCount}
            expanded={expanded.has(n.s.id)}
            onToggle={toggle}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Uncommitted work, on the card.
 *
 * The thing that goes wrong with many agents at once is losing track of which of them has written
 * something that exists nowhere but its own working tree. Staged and unstaged are counted apart
 * because they are one step apart in the flow, and a card is the only place the whole fleet is
 * visible at once.
 */
function DirtyChip({ dirty }: { dirty: Dirty | null }): JSX.Element | null {
  if (!dirty || dirty.changed + dirty.staged === 0) return null
  const parts: string[] = []
  if (dirty.changed) parts.push(`${dirty.changed} changed`)
  if (dirty.staged) parts.push(`${dirty.staged} staged`)
  return (
    <span
      className="lbl rounded px-1 py-0.5"
      style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 14%, transparent)' }}
      title={`${parts.join(' · ')} · uncommitted, in this agent's checkout only`}
    >
      {dirty.changed + dirty.staged} open
    </span>
  )
}

function SessionCard({
  n: s,
  x,
  y,
  now,
  selected,
  tint,
  unread,
  dirty,
  childCount,
  expanded,
  onToggle,
  onSelect,
  onOpen
}: {
  n: Session
  x: number
  y: number
  now: number
  selected: boolean
  tint: string
  /** flagged and not yet read: 'done' has news, 'waiting' is blocked on you */
  unread: 'waiting' | 'done' | null
  childCount: number
  /** uncommitted work in this agent's own checkout, null while it is unknown */
  dirty: Dirty | null
  expanded: boolean
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const kind = s.origin === 'subagent' ? `subagent · ${s.agentType ?? 'agent'}` : s.origin === 'app' ? 'launched' : 'terminal'
  const kindCls = s.origin === 'app' ? '!text-[var(--accent)]' : s.origin === 'subagent' ? '!text-[var(--sub)]' : ''
  return (
    <div
      className={`card absolute cursor-pointer px-3 py-2 ${tone(s.state)} ${selected ? 'card-selected' : ''} ${
        s.origin === 'subagent' ? 'border-dashed' : ''
      } ${unread === 'waiting' ? 'card-unread-wait' : unread === 'done' ? 'card-unread' : ''}`}
      style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
      onClick={() => onOpen(s.id)}
      onMouseEnter={() => onSelect(s.id)}
    >
      <span className="absolute inset-y-[6px] left-0 w-[3px] rounded-r" style={{ background: tint, opacity: 0.9 }} />
      <div className="flex items-center gap-1.5">
        <span className={`lbl truncate ${kindCls}`}>{kind}</span>
        {/* two agents in one repo look alike until you can see which is isolated */}
        {s.worktree && (
          <span className="lbl rounded bg-[var(--raised)] px-1 py-0.5" title={`isolated worktree: ${s.worktree}`}>
            wt
          </span>
        )}
        <DirtyChip dirty={dirty} />
        <span className="ml-auto shrink-0">
          <StateChip state={s.state} pulse={s.state === 'running'} />
        </span>
      </div>
      <div className="mt-1 truncate text-[12px] font-semibold" title={title(s)}>
        {title(s)}
      </div>
      <div className="mono mt-1 flex items-center gap-2 text-[10px] text-[var(--muted)]">
        <span className="truncate">
          {s.origin === 'subagent'
            ? (s.model?.replace(/^claude-/, '') ?? 'agent')
            : s.worktree
              ? `wt:${s.worktree}`
              : (s.branch ?? '—')}
        </span>
        {s.lastCommand && <span className="truncate text-[var(--fg)]/70">{s.lastCommand}</span>}
        <span className="ml-auto shrink-0 text-[var(--dim)]">
          {tokens(s.tokens.output)} out · {age(s.lastEventAt, now)}
        </span>
      </div>
      <div className="mono mt-1 truncate text-[9.5px]">
        {s.state === 'running' && s.currentTool ? (
          <span className="text-[var(--accent)]">▸ {s.currentTool}</span>
        ) : s.state === 'waiting' ? (
          <span className="text-[var(--warn)]">⚠ needs your approval</span>
        ) : (
          <span className="text-[var(--dim)]">{s.lastPrompt ? s.lastPrompt.split('\n')[0].slice(0, 60) : ''}</span>
        )}
      </div>
      {childCount > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggle(s.id)
          }}
          title={`${childCount} subagent${childCount > 1 ? 's' : ''}`}
          className="mono absolute -right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-[var(--line)] bg-[var(--raised)] px-1.5 py-0.5 text-[9px] text-[var(--muted)] hover:border-[#bb9af7] hover:text-[#bb9af7]"
        >
          {expanded ? '−' : '+'}
          {childCount}
        </button>
      )}
    </div>
  )
}

// the whole card carries the state, so a busy fleet reads at a glance
function tone(state: Session['state']): string {
  if (state === 'running') return 'card-running'
  if (state === 'waiting') return 'card-waiting'
  if (state === 'stale' || state === 'ended') return 'card-quiet'
  return ''
}

// topic, else the first prompt line with markdown noise stripped, else the repo
function title(s: Session): string {
  if (s.topic) return s.topic
  const first = s.lastPrompt?.split('\n').find((l) => l.trim()) ?? ''
  const clean = first.replace(/^[\s#*>\-`]+/, '').replace(/[*`_]+/g, '').trim()
  return clean || s.repo
}

export function StateChip({ state, pulse }: { state: Session['state'] | 'exited'; pulse?: boolean }): JSX.Element {
  const label = state === 'waiting' ? 'needs you' : state
  return <span className={`chip chip-${state} ${pulse ? 'node-breathe' : ''}`}>{label}</span>
}
