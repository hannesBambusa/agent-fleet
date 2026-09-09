import { useEffect, useState } from 'react'
import type { Session } from '../../../shared/types'

export function useSessions(): Session[] {
  const [map, setMap] = useState<Map<string, Session>>(new Map())
  useEffect(() => {
    let alive = true
    void window.api.sessions.listSessions().then((list) => {
      if (alive) setMap(new Map(list.map((s) => [s.id, s])))
    })
    const off = window.api.sessions.onSessionUpdate((s) => {
      setMap((prev) => {
        const next = new Map(prev)
        next.set(s.id, s)
        return next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return [...map.values()].sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''))
}
