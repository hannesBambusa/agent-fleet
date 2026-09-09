import { useEffect, useRef, useState } from 'react'

// A build or a long tool call pushes pty output in a flood of tiny chunks, and a setState per chunk
// would re-render the whole fleet hundreds of times a second. Timestamps land in a ref and reach
// React on this interval instead; a second of lag does not matter to a 25 second liveness window.
const FLUSH_MS = 1_000

/**
 * Last moment each agent's pty produced output, by agent id. This is the only evidence the renderer
 * has that a session is alive while Claude Code has not written its transcript file yet.
 */
export function usePtyActivity(): Map<string, number> {
  const [seen, setSeen] = useState<Map<string, number>>(new Map())
  const buf = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const off = window.api.pty.onData((id) => {
      buf.current.set(id, Date.now())
    })
    const t = setInterval(() => {
      if (!buf.current.size) return
      const batch = buf.current
      buf.current = new Map()
      setSeen((prev) => {
        const next = new Map(prev)
        for (const [id, ts] of batch) next.set(id, ts)
        return next
      })
    }, FLUSH_MS)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])
  return seen
}
