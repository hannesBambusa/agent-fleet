import { useEffect, useState } from 'react'
import type { Session } from '../../../shared/types'

/** slower than the session tick: a working tree changes on a human scale, not a token one */
const POLL_MS = 6000

export interface Dirty {
  changed: number
  staged: number
}

/**
 * Uncommitted counts per checkout, for the fleet.
 *
 * Asked for every agent at once rather than per card, so the cost is one round trip on a slow timer
 * instead of a git process per card per tick. Subagents share their parent's directory and are
 * dropped here, because the same tree reported twice is the same tree.
 */
export function useDirty(sessions: Session[]): Map<string, Dirty> {
  const [map, setMap] = useState<Map<string, Dirty>>(new Map())
  // a plain string of the directories, so the effect restarts when the fleet changes and not on
  // every unrelated session update
  const key = [...new Set(sessions.filter((s) => !s.parentId).map((s) => s.cwd))].sort().join('\n')

  useEffect(() => {
    const dirs = key ? key.split('\n') : []
    if (!dirs.length) {
      setMap(new Map())
      return
    }
    let alive = true
    const read = (): void => {
      void window.api.git
        .dirty(dirs)
        .then((res) => {
          if (alive) setMap(new Map(Object.entries(res)))
        })
        .catch(() => undefined)
    }
    read()
    const t = setInterval(read, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [key])

  return map
}
