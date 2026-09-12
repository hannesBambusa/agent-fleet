import { useEffect, useState } from 'react'
import type { Session } from '../../../shared/types'
import { repoColor } from '../lib/repoColor'
import { useFlagged } from '../state/attention'

const accent: Record<Session['state'], string> = {
  running: 'var(--accent)',
  waiting: 'var(--warn)',
  idle: 'var(--muted)',
  stale: 'var(--dim)',
  ended: 'var(--dim)'
}

/**
 * One or two characters standing in for the whole agent.
 *
 * A worktree's trailing number is the thing that actually tells two agents in one repository apart,
 * and it is what the rest of the app calls them (`agent-6`, `wt:agent-6`), so it wins. Failing that
 * the first letter of whatever the agent is named after, which is at least stable.
 */
export function tag(s: Session): string {
  const n = s.worktree ? /(\d+)$/.exec(s.worktree)?.[1] : null
  if (n) return n.slice(-2)
  const from = s.topic ?? s.worktree ?? s.repo
  return (from.replace(/^(worktree-|wt:)/, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
}

function title(s: Session): string {
  const name = s.topic ?? s.lastPrompt?.split('\n')[0] ?? s.repo
  return `${name} · ${s.repo}${s.worktree ? ` · wt:${s.worktree}` : ''} · ${s.state}`
}

/**
 * The fleet as a column of tiles, for a sidebar too narrow for words.
 *
 * At this width nothing can be read, so nothing is written: what survives is the things a glance is
 * actually for — how many agents there are, which repository each belongs to by colour, which are
 * running, and which want something. Everything else is in the tooltip, and widening the panel
 * brings it back.
 */
export function Dock({
  sessions,
  opened,
  onOpen,
  onExpand
}: {
  sessions: Session[]
  opened: string | null
  onOpen: (id: string) => void
  onExpand: () => void
}): JSX.Element {
  // One agent per row, the full width of whatever the panel has been dragged to. A grid packs more
  // in, but it costs the thing this view is for: the order down the column is the order of the
  // fleet, and two per row makes that order something to work out rather than read.
  const flagged = useFlagged()
  const [, bump] = useState(0)
  useEffect(() => {
    const h = (): void => bump((n) => n + 1)
    window.addEventListener('agent-fleet:repo-colors', h)
    return () => window.removeEventListener('agent-fleet:repo-colors', h)
  }, [])

  // roots only: a subagent has no life of its own to watch at this size
  const roots = sessions.filter((s) => !s.parentId)
  const byRepo = new Map<string, Session[]>()
  for (const s of roots) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s])
  const groups = [...byRepo.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([repo, list]) => [repo, list.slice().sort((x, y) => (x.firstEventAt ?? '').localeCompare(y.firstEventAt ?? ''))] as const)
  const kidsOf = (id: string): number => sessions.filter((s) => (s.parentAgentId ?? s.parentId) === id).length

  return (
    <aside className="swap-narrow flex h-full min-h-0 w-full flex-col items-center gap-2 overflow-y-auto py-2">
      {groups.map(([repo, list]) => (
        <div key={repo} className="flex w-full flex-col items-center gap-1.5" title={repo}>
          {/* the repository, as its colour and nothing else */}
          <span
            className="h-[2px] w-[60%] min-w-[18px] rounded-full"
            style={{ background: repoColor(list[0].repoPath) }}
            aria-hidden
          />
          <div className="flex w-full flex-col items-stretch gap-1.5 px-1">
          {list.map((s, i) => {
            const on = s.id === opened
            const live = s.state === 'running'
            const wait = s.state === 'waiting'
            const flag = flagged.get(s.id) ?? null
            const kids = kidsOf(s.id)
            return (
              <button
                key={s.id}
                onClick={() => onOpen(s.id)}
                title={title(s)}
                className={`tile-in relative flex h-[26px] w-full shrink-0 items-center justify-center rounded-md border text-[11px] ${
                  live ? 'node-breathe' : ''
                }`}
                // each tile lands a beat after the one above it, so the column assembles downwards
                // rather than appearing whole
                style={{
                  animationDelay: `${Math.min(i, 12) * 22}ms`,
                  borderColor: on ? 'var(--fg)' : wait ? 'var(--warn)' : live ? 'var(--accent)' : 'var(--line)',
                  background: on ? 'var(--raised)' : 'var(--panel)',
                  color: wait ? 'var(--warn)' : live ? 'var(--accent)' : 'var(--muted)',
                  boxShadow: live ? '0 0 8px var(--accent-soft)' : undefined
                }}
              >
                {tag(s)}
                {/* it stopped with something to say, and this is the only room left to say it in */}
                {flag && (
                  <span
                    className="absolute -right-[3px] -top-[3px] h-[7px] w-[7px] rounded-full"
                    style={{
                      background: flag === 'waiting' ? 'var(--warn)' : 'var(--accent)',
                      boxShadow: '0 0 0 1.5px var(--ink)'
                    }}
                  />
                )}
                {kids > 0 && (
                  <span
                    className="mono absolute -bottom-[4px] -right-[4px] rounded-full px-[3px] text-[7.5px] leading-[10px]"
                    style={{ background: 'var(--ink)', color: 'var(--sub)', boxShadow: '0 0 0 1px var(--line)' }}
                  >
                    {kids}
                  </span>
                )}
              </button>
            )
          })}
          </div>
        </div>
      ))}

      <button
        onClick={onExpand}
        title="widen the fleet"
        className="mono mt-auto shrink-0 rounded px-1 py-0.5 text-[11px] text-[var(--dim)] hover:text-[var(--accent)]"
      >
        »
      </button>
    </aside>
  )
}
