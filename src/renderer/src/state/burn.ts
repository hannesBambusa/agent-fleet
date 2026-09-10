import { useEffect, useRef, useState } from 'react'
import type { UsageLimit, UsageSnapshot } from '../../../shared/types'
import { readPersisted, writePersisted } from './store'
import { project, rateOf, type Burn, type Sample } from './burnRate'

export type { Burn, Sample } from './burnRate'

// long enough to average out a burst, short enough to notice you have stopped working
const WINDOW_MS = 30 * 60 * 1000
const KEY = 'usageSamples'

/** The five hour window, which is the one that actually stops you working. */
function sessionLimit(snap: UsageSnapshot | null): UsageLimit | null {
  return snap?.limits.find((l) => l.kind === 'session') ?? null
}

export function useBurn(snap: UsageSnapshot | null, now: number): Burn | null {
  const samples = useRef<Sample[]>(readPersisted<Sample[]>(KEY, []))
  const [burn, setBurn] = useState<Burn | null>(null)

  useEffect(() => {
    const limit = sessionLimit(snap)
    if (!limit) return
    const at = snap?.fetchedAt ?? Date.now()
    const last = samples.current[samples.current.length - 1]
    // the window resetting is a cliff, not a rate: start again from there
    if (last && limit.percent < last.pct - 1) samples.current = []
    if (!last || last.at !== at) {
      samples.current = [...samples.current, { at, pct: limit.percent }].filter((s) => at - s.at <= WINDOW_MS)
      writePersisted(KEY, samples.current)
    }
    const { perHour, spanMs } = rateOf(samples.current)
    setBurn({ ...project(limit.percent, perHour, limit.resetsAt, Date.now()), spanMs })
  }, [snap])

  if (!burn) return null
  // the projection is recomputed against the clock so it counts down between polls
  const limit = sessionLimit(snap)
  return { ...project(limit?.percent ?? 0, burn.perHour, limit?.resetsAt ?? null, now), spanMs: burn.spanMs }
}
