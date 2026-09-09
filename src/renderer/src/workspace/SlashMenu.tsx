import { useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogItem } from '../../../shared/types'
import { slashItems, TONE, type SlashItem } from './slash'

/**
 * The menu itself.
 *
 * Claude Code's own list is one dense column of names; this one carries the description beside each,
 * the source as a colour, and what the command takes underneath the selection, because the reason to
 * open it is usually "which of these did I want" rather than "how is it spelled".
 */
export function SlashMenu({
  items,
  index,
  keyed,
  onPick,
  onHover
}: {
  items: SlashItem[]
  index: number
  /** bumped only when the keyboard moved the selection, never by the mouse */
  keyed: number
  onPick: (item: SlashItem) => void
  onHover: (i: number) => void
}): JSX.Element | null {
  const box = useRef<HTMLDivElement>(null)
  // Scrolling the selection into view is for the keyboard. Doing it on hover shifts a partly visible
  // row under the pointer, which reads as the list twitching as the mouse crosses it.
  useEffect(() => {
    if (!keyed) return
    box.current?.querySelector<HTMLElement>('[data-on="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [keyed])
  if (!items.length) return null
  const current = items[Math.min(index, items.length - 1)]
  return (
    <div className="mb-1 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)] shadow-2xl">
      <div ref={box} className="max-h-[260px] overflow-auto py-1">
        {items.map((it, i) => {
          const on = i === index
          return (
            <button
              key={it.token}
              data-on={on}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(it)}
              className={`flex w-full items-baseline gap-2 px-2.5 py-[5px] text-left ${on ? 'bg-[var(--raised)]' : ''}`}
              style={on ? { boxShadow: `inset 2px 0 0 ${TONE[it.source]}` } : undefined}
            >
              <span className="mono shrink-0 text-[11.5px]" style={{ color: on ? TONE[it.source] : 'var(--fg)' }}>
                /{it.token}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]">{it.description}</span>
              {it.kind === 'skill' && <span className="lbl shrink-0">skill</span>}
              <span className="lbl shrink-0" style={{ color: on ? TONE[it.source] : undefined }}>
                {it.source}
              </span>
            </button>
          )
        })}
      </div>
      <div className="flex items-baseline gap-2 border-t border-[var(--line)] px-2.5 py-1.5">
        <span className="lbl shrink-0">↑↓ move · ↵ pick · esc close</span>
        {current?.hint && <span className="mono ml-auto truncate text-[10px] text-[var(--dim)]">takes: {current.hint}</span>}
      </div>
    </div>
  )
}

export function useCatalogItems(): SlashItem[] {
  const [items, setItems] = useState<CatalogItem[]>([])
  useEffect(() => {
    void window.api
      .catalog()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])
  return useMemo(() => slashItems(items), [items])
}
