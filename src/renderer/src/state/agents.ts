import { useEffect, useState } from 'react'
import type { Agent, Repo } from '../../../shared/types'

export function useAgents(): Agent[] {
  const [map, setMap] = useState<Map<string, Agent>>(new Map())
  useEffect(() => {
    let alive = true
    void window.api.agents.listAgents().then((list) => {
      if (alive) setMap(new Map(list.map((a) => [a.id, a])))
    })
    const off1 = window.api.agents.onUpdate((a) =>
      setMap((prev) => {
        const next = new Map(prev)
        next.set(a.id, a)
        return next
      })
    )
    const off2 = window.api.agents.onRemoved((id) =>
      setMap((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    )
    return () => {
      alive = false
      off1()
      off2()
    }
  }, [])
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function useRepos(): { repos: Repo[]; refresh: () => Promise<void> } {
  const [repos, setRepos] = useState<Repo[]>([])
  const refresh = async (): Promise<void> => setRepos(await window.api.repos.listRepos())
  useEffect(() => {
    void refresh()
  }, [])
  return { repos, refresh }
}
