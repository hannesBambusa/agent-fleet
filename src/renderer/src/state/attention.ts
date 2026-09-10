import { useEffect, useState } from 'react'
import type { AttentionItem } from '../../../shared/types'

/**
 * Which sessions are still asking for something, for the views that draw them.
 *
 * The queue in the top bar is the list; this is the same truth as a lookup, so a card can say "I
 * have finished and you have not read it yet" without every view fetching its own copy.
 */
export function useFlagged(): Map<string, AttentionItem['kind']> {
  const [items, setItems] = useState<AttentionItem[]>([])
  useEffect(() => {
    void window.api.attention.list().then(setItems)
    return window.api.attention.onUpdate(setItems)
  }, [])
  const out = new Map<string, AttentionItem['kind']>()
  // waiting outranks done: it is the one that blocks
  for (const i of items) if (i.kind === 'done' && !out.has(i.sessionId)) out.set(i.sessionId, 'done')
  for (const i of items) if (i.kind === 'waiting') out.set(i.sessionId, 'waiting')
  return out
}
