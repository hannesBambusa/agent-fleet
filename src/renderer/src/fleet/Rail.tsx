import type { Session } from '../../../shared/types'
import { age } from '../lib/format'
import { repoColor } from '../lib/repoColor'

interface Props {
  sessions: Session[]
  opened: string | null
  now: number
  onOpen: (id: string) => void
  onFleet: () => void
}

// the subagent hue is a theme variable now, so it can darken on a light ground
const SUB = 'var(--sub)'

const accent: Record<Session['state'], string> = {
  running: 'var(--accent)',
  waiting: 'var(--warn)',
  idle: 'var(--muted)',
  stale: 'var(--dim)',
  ended: 'var(--dim)'
}

// compact list of every session, shown beside an open agent so the fleet stays in view
export function Rail({ sessions, opened, now, onOpen, onFleet }: Props): JSX.Element {
  const byRepo = new Map<string, Session[]>()
  const kids = new Map<string, Session[]>()
  for (const s of sessions) {
    if (s.parentId) kids.set(s.parentAgentId ?? s.parentId, [...(kids.get(s.parentAgentId ?? s.parentId) ?? []), s])
    else byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s])
  }
  // same stable order as the graph: by repo name, then by when each session started
  const groups = new Map(
    [...byRepo.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([repo, list]) =>
          [
            repo,
            list.slice().sort((a, b) => (a.firstEventAt ?? '').localeCompare(b.firstEventAt ?? '') || a.id.localeCompare(b.id))
          ] as [string, Session[]]
      )
  )
  // flatten each root with its subagents nested underneath, depth for indent
  const flat = (s: Session, depth: number): Array<{ s: Session; depth: number }> => [
    { s, depth },
    ...(kids.get(s.id) ?? []).flatMap((c) => flat(c, depth + 1))
  ]
  const waiting = sessions.filter((s) => s.state === 'waiting').length
  const running = sessions.filter((s) => s.state === 'running').length
  const roots = sessions.filter((s) => !s.parentId).length

  return (
    <aside className="flex h-full w-full flex-col bg-[var(--panel)]">
      <button
        onClick={onFleet}
        title="back to the full fleet"
        className="flex shrink-0 cursor-pointer items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5 text-left hover:bg-[var(--hover)]"
      >
        <span className="lbl !text-[var(--fg)]">// fleet</span>
        {waiting > 0 ? (
          <span className="chip chip-waiting dot-blink">{waiting} waiting</span>
        ) : running > 0 ? (
          <span className="chip chip-running">{running} running</span>
        ) : (
          <span className="lbl">{roots} idle</span>
        )}
      </button>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {[...groups.entries()].map(([repo, list]) => {
          const tint = repoColor(list[0].repoPath)
          const live = list.filter((r) => flat(r, 0).some(({ s }) => s.state === 'running' || s.state === 'waiting')).length
          return (
          <div key={repo} className="mb-2">
            {/* Sticky, so the repo stays named while its agents scroll past: the whole point of the
                compact view is many agents at once, and a header that scrolls away leaves rows that
                could belong to anything. */}
            <div
              className="sticky top-0 z-10 flex items-center gap-1.5 border-y border-[var(--line)] px-3 py-1"
              style={{ background: `color-mix(in srgb, ${tint} 16%, var(--panel))` }}
            >
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: tint }} />
              <span className="mono min-w-0 flex-1 truncate text-[10px] font-medium tracking-wide text-[var(--fg)]" title={repo}>
                {repo}
              </span>
              {live > 0 && <span className="mono shrink-0 text-[9px]" style={{ color: tint }}>{live} live</span>}
              <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{list.length}</span>
            </div>
            {/* the spine carries the repo's colour down every row that belongs to it */}
            <div style={{ borderLeft: `2px solid ${tint}`, background: `color-mix(in srgb, ${tint} 4%, transparent)` }}>
            {list
              .flatMap((r) => flat(r, 0))
              .map(({ s, depth }) => {
                const on = s.id === opened
                const live = s.state === 'running'
                const wait = s.state === 'waiting'
                const quiet = s.state === 'stale' || s.state === 'ended'
                const sub = s.origin === 'subagent'
                // a subagent is purple wherever it appears; only its waiting state borrows amber
                const tone = wait ? accent.waiting : sub ? SUB : accent[s.state]
                return (
                  <button
                    key={s.id}
                    onClick={() => onOpen(s.id)}
                    style={{ paddingLeft: 12 + depth * 12 }}
                    title={`${s.repo} · ${s.state}${s.currentTool ? ` · ${s.currentTool}` : ''}`}
                    className={`relative flex w-full cursor-pointer items-center gap-2 py-[7px] pr-2.5 text-left transition-colors ${
                      on ? 'bg-[var(--raised)]' : 'hover:bg-[var(--hover)]'
                    } ${live ? (sub ? 'rail-live rail-live-sub' : 'rail-live') : ''} ${quiet ? 'opacity-70' : ''}`}
                  >
                    {/* the left bar is the state: green while it works, amber when it needs you */}
                    <span
                      className={`absolute inset-y-[3px] left-0 w-[2px] rounded-r ${wait ? 'dot-blink' : ''}`}
                      style={{ background: live || wait ? tone : on ? 'var(--fg)' : 'transparent' }}
                    />
                    <span
                      className={`h-[7px] w-[7px] shrink-0 ${
                        s.origin === 'app' ? 'rounded-[2px]' : s.origin === 'subagent' ? 'rotate-45 rounded-[1px]' : 'rounded-full'
                      }`}
                      style={{
                        background: sub && !wait ? SUB : accent[s.state],
                        boxShadow: live ? `0 0 8px ${sub ? SUB : 'var(--accent)'}` : wait ? '0 0 8px var(--warn)' : undefined
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[11px] leading-tight ${live || wait || on ? 'text-[var(--fg)]' : ''}`}>
                        {s.topic ?? s.lastPrompt?.split('\n')[0] ?? s.repo}
                      </span>
                      <span className="mono block truncate text-[9px] leading-[1.5] text-[var(--dim)]">
                        {wait ? (
                          <span className="text-[var(--warn)]">needs your approval</span>
                        ) : live ? (
                          <span style={{ color: tone }}>{s.currentTool ? `▸ ${s.currentTool}` : 'working'}</span>
                        ) : (
                          (s.lastCommand ?? (s.worktree ? `wt:${s.worktree}` : s.branch) ?? '')
                        )}
                      </span>
                    </span>
                    <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{age(s.lastEventAt, now)}</span>
                  </button>
                )
              })}
            </div>
          </div>
          )
        })}
      </div>
    </aside>
  )
}
