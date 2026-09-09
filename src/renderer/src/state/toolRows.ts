import { useCallback, useEffect, useState } from 'react'

const KEY = 'agent-fleet.toolRowsOpen'
const EVENT = 'agent-fleet:tool-rows'

/**
 * Whether a tool call in the chat starts open.
 *
 * Reading a turn and skimming one are different jobs: following an agent live, the diffs are the
 * point and clicking each row is friction; catching up on a long turn, the same diffs are a wall.
 * The choice is per person, not per row, and each row can still be opened or closed on its own.
 */
export function readToolRows(): boolean {
  try {
    return localStorage.getItem(KEY) === 'open'
  } catch {
    return false
  }
}

export function toggleToolRows(): void {
  const next = !readToolRows()
  try {
    localStorage.setItem(KEY, next ? 'open' : 'closed')
  } catch {
    // storage unavailable: the choice just does not persist
  }
  window.dispatchEvent(new CustomEvent(EVENT))
}

export function useToolRows(): boolean {
  const [open, setOpen] = useState(readToolRows)
  const sync = useCallback(() => setOpen(readToolRows()), [])
  useEffect(() => {
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [sync])
  return open
}
