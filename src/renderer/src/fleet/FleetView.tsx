import { useMemo, useState } from 'react'
import type { Session, UsageSnapshot } from '../../../shared/types'
import { applyFilter, emptyFilter, Filters, type FilterState, type FleetTab } from './Filters'
import { Canvas } from './Canvas'
import { FleetWaterfall } from './FleetWaterfall'
import { FleetHistory } from './FleetHistory'
import { FleetUsage } from './FleetUsage'

interface Props {
  sessions: Session[]
  usage: UsageSnapshot | null
  // includes finished subagents and closed sessions; only the history tab uses it
  history: Session[]
  selected: string | null
  now: number
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}

// graph or waterfall with its filter row; the detail panel / workspace lives to the right of it in App
export function FleetView({ sessions, history, usage, selected, now, onSelect, onOpen }: Props): JSX.Element {
  const [filter, setFilter] = useState<FilterState>(emptyFilter)
  const [view, setView] = useState<FleetTab>('graph')
  const shown = useMemo(() => applyFilter(sessions, filter), [sessions, filter])
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <Filters sessions={sessions} value={filter} onChange={setFilter} shown={shown.length} view={view} onView={setView} />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {view === 'graph' ? (
          <Canvas sessions={shown} selected={selected} now={now} onSelect={onSelect} onOpen={onOpen} />
        ) : view === 'waterfall' ? (
          <FleetWaterfall sessions={shown.filter((s) => !s.parentId)} selected={selected} now={now} onSelect={onSelect} onOpen={onOpen} />
        ) : view === 'history' ? (
          <FleetHistory sessions={history} selected={selected} now={now} onSelect={onSelect} onOpen={onOpen} />
        ) : (
          <FleetUsage sessions={history} snap={usage} onOpen={onOpen} />
        )}
      </div>
    </div>
  )
}
