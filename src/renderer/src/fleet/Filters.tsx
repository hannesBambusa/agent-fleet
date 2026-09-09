import type { Session } from '../../../shared/types'

export interface FilterState {
  q: string
  state: 'all' | Session['state']
  origin: 'all' | 'app' | 'terminal' | 'subagent'
  repo: 'all' | string
}

export type FleetTab = 'graph' | 'waterfall' | 'history' | 'usage'

export const emptyFilter: FilterState = { q: '', state: 'all', origin: 'all', repo: 'all' }

export function applyFilter(sessions: Session[], f: FilterState): Session[] {
  const q = f.q.trim().toLowerCase()
  const hit = sessions.filter((s) => matches(s, f, q))
  const keep = new Set(hit.map((s) => s.id))
  // a subagent needs its ancestors on the canvas to hang from
  for (const s of hit) {
    if (s.parentId) keep.add(s.parentId)
    if (s.parentAgentId) keep.add(s.parentAgentId)
  }
  return sessions.filter((s) => keep.has(s.id))
}

function matches(s: Session, f: FilterState, q: string): boolean {
  return ((): boolean => {
    if (f.state !== 'all' && s.state !== f.state) return false
    if (f.origin !== 'all' && s.origin !== f.origin) return false
    if (f.repo !== 'all' && s.repoPath !== f.repo) return false
    if (!q) return true
    return [s.topic, s.repo, s.branch, s.lastCommand, s.lastPrompt, s.currentTool, s.model, s.agentType]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q))
  })()
}

interface Props {
  sessions: Session[]
  value: FilterState
  onChange: (f: FilterState) => void
  shown: number
  view: FleetTab
  onView: (v: FleetTab) => void
}

export function Filters({ sessions, value, onChange, shown, view, onView }: Props): JSX.Element {
  const repos = [...new Map(sessions.map((s) => [s.repoPath, s.repo])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const set = (patch: Partial<FilterState>): void => onChange({ ...value, ...patch })
  return (
    <div className="flex shrink-0 flex-wrap items-end gap-x-5 gap-y-2 border-b border-[var(--line)] px-4 pb-2 pt-2">
      <div className="flex items-end gap-0 self-stretch">
        <Tab on={view === 'graph'} onClick={() => onView('graph')}>
          graph
        </Tab>
        <Tab on={view === 'waterfall'} onClick={() => onView('waterfall')}>
          waterfall
        </Tab>
        <Tab on={view === 'history'} onClick={() => onView('history')}>
          history
        </Tab>
        <Tab on={view === 'usage'} onClick={() => onView('usage')}>
          usage
        </Tab>
      </div>
      <Field label="search">
        <input
          className="field w-56"
          placeholder="topic, repo, branch, command…"
          value={value.q}
          onChange={(e) => set({ q: e.target.value })}
        />
      </Field>
      <Field label="status">
        <select className="field" value={value.state} onChange={(e) => set({ state: e.target.value as FilterState['state'] })}>
          <option value="all">All statuses</option>
          <option value="waiting">Waiting for you</option>
          <option value="running">Running</option>
          <option value="idle">Idle</option>
          <option value="stale">Stale</option>
        </select>
      </Field>
      <Field label="origin">
        <select className="field" value={value.origin} onChange={(e) => set({ origin: e.target.value as FilterState['origin'] })}>
          <option value="all">All origins</option>
          <option value="app">Launched here</option>
          <option value="terminal">From terminal</option>
          <option value="subagent">Subagents</option>
        </select>
      </Field>
      <Field label="repo">
        <select className="field" value={value.repo} onChange={(e) => set({ repo: e.target.value })}>
          <option value="all">All repos</option>
          {repos.map(([path, name]) => (
            <option key={path} value={path}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <button className="chip mb-0.5 hover:text-[var(--fg)]" onClick={() => onChange(emptyFilter)}>
        reset
      </button>
      <div className="lbl ml-auto mb-1">
        {shown} / {sessions.length} sessions
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="lbl">{label}</span>
      {children}
    </label>
  )
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`lbl -mb-2 border-b-2 px-3 pb-2.5 pt-1 ${on ? 'border-[var(--accent)] !text-[var(--fg)]' : 'border-transparent hover:!text-[var(--muted)]'}`}
    >
      {children}
    </button>
  )
}
