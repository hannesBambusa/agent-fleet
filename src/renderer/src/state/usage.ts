import { useEffect, useState } from 'react'
import type { UsageSnapshot } from '../../../shared/types'

// the status line writes several times a second while an agent works, so this can be read often
const POLL_MS = 8_000

// one poller for the whole app; the snapshot is small and Claude Code refreshes it on its own clock
export function useUsage(): UsageSnapshot | null {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.usage().then((s) => {
        if (alive) setSnap(s)
      })
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  return snap
}
