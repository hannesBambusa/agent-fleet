import { useEffect, useState } from 'react'
import { verbIn } from './verbIn'

export { verbIn } from './verbIn'

// a chunk arrives mid-word, so a short tail is kept per agent before matching
const TAIL = 600

export function usePtyVerb(): Map<string, { verb: string; at: number }> {
  const [verbs, setVerbs] = useState<Map<string, { verb: string; at: number }>>(new Map())
  useEffect(() => {
    const tails = new Map<string, string>()
    return window.api.pty.onData((id, data) => {
      const tail = ((tails.get(id) ?? '') + data).slice(-TAIL)
      tails.set(id, tail)
      const verb = verbIn(tail)
      if (!verb) return
      setVerbs((prev) => {
        const seen = prev.get(id)
        if (seen?.verb === verb && Date.now() - seen.at < 1000) return prev
        const next = new Map(prev)
        next.set(id, { verb, at: Date.now() })
        return next
      })
    })
  }, [])
  return verbs
}
