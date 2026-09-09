import { useMemo, useState } from 'react'
import type { Session, UsageSnapshot } from '../../../shared/types'
import { applyFilter, emptyFilter, Filters, type FilterState, type FleetTab } from './Filters'
import { Canvas } from './Canvas'
import { FleetWaterfall } from './FleetWaterfall'
import { FleetHistory } from './FleetHistory'
import { FleetUsage } from './FleetUsage'
import { Catalog } from './Catalog'
import { Rail } from './Rail'

interface Props {
  sessions: Session[]
  usage: UsageSnapshot | null
  // includes finished subagents and closed sessions; only the history tab uses it
  history: Session[]
  selected: string | null
  now: number
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  /** the panel is too narrow for the graph, so the fleet is drawn as the rail instead */
  compact: boolean
  /** the session open in the workspace, marked in the rail */
  opened: string | null
  /** widen the panel back out of compact */
  onExpand: () => void
}

/**
 * What the left panel shows.
 *
 * Two levels, deliberately. The section decides what you are looking at — the sessions running now,
 * or what Claude Code can do here at all — and only the sessions have a second row, for the shape
 * they are drawn in. Folding those into one row made "usage" and "waterfall" look like the same kind
 * of choice, which they are not.
 */
type Section = 'fleet' | 'skills' | 'commands' | 'agents' | 'usage'

const SECTIONS: Array<{ id: Section; label: string; title: string }> = [
  { id: 'fleet', label: 'fleet', title: 'the sessions running right now' },
  { id: 'skills', label: 'skills', title: 'every skill installed for Claude Code' },
  { id: 'commands', label: 'commands', title: 'every slash command available' },
  { id: 'agents', label: 'agents', title: 'every subagent definition' },
  { id: 'usage', label: 'usage', title: 'tokens and plan limits' }
]

export function FleetView({
  sessions,
  history,
  usage,
  selected,
  now,
  onSelect,
  onOpen,
  compact,
  opened,
  onExpand
}: Props): JSX.Element {
  const [section, setSection] = useState<Section>('fleet')
  const [filter, setFilter] = useState<FilterState>(emptyFilter)
  const [view, setView] = useState<FleetTab>('graph')
  const shown = useMemo(() => applyFilter(sessions, filter), [sessions, filter])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* the sections stay reachable at every width: narrow only wraps them onto a second row */}
      <div className={`flex shrink-0 flex-wrap items-center gap-0 border-b border-[var(--line)] ${compact ? 'px-1.5' : 'px-3'}`}>
        {SECTIONS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSection(t.id)}
            title={t.title}
            className={`lbl border-b-2 py-2 ${compact ? 'px-1.5' : 'px-3'} ${
              section === t.id
                ? 'border-[var(--accent)] !text-[var(--fg)]'
                : 'border-transparent hover:!text-[var(--muted)]'
            }`}
          >
            {t.label}
            {t.id === 'fleet' && sessions.length ? (
              <span className="ml-1.5 text-[var(--dim)]">{sessions.filter((s) => !s.parentId).length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {section === 'fleet' && !compact && (
        <Filters sessions={sessions} value={filter} onChange={setFilter} shown={shown.length} view={view} onView={setView} />
      )}

      {/* keyed on what is drawn, so switching section or folding to the rail plays the entry
          animation instead of the panel changing under you in one frame */}
      <div
        key={`${section}:${compact}`}
        className={`min-h-0 min-w-0 flex-1 overflow-hidden ${compact ? 'swap-narrow' : 'swap-wide'}`}
      >
        {section === 'usage' ? (
          <FleetUsage sessions={history} snap={usage} onOpen={onOpen} />
        ) : section === 'skills' ? (
          <Catalog kind="skill" />
        ) : section === 'commands' ? (
          <Catalog kind="command" />
        ) : section === 'agents' ? (
          <Catalog kind="agent" />
        ) : compact ? (
          <Rail sessions={sessions} opened={opened} now={now} onOpen={onOpen} onFleet={onExpand} />
        ) : view === 'graph' ? (
          <Canvas sessions={shown} selected={selected} now={now} onSelect={onSelect} onOpen={onOpen} />
        ) : view === 'waterfall' ? (
          <FleetWaterfall sessions={shown.filter((s) => !s.parentId)} selected={selected} now={now} onSelect={onSelect} onOpen={onOpen} />
        ) : (
          <FleetHistory sessions={history} selected={selected} now={now} onSelect={onSelect} onOpen={onOpen} />
        )}
      </div>
    </div>
  )
}
