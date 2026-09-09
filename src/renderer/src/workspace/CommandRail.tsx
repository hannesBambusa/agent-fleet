import { useEffect, useRef, useState } from 'react'
import type { SessionCommand } from '../../../shared/types'
import { age, clock, dur } from '../lib/format'

export function CommandRail({ list, now, width }: { list: SessionCommand[]; now: number; width: number }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  // follow the newest, the way the chat does
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [list.length])

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-l border-[var(--line)] bg-[var(--panel)]"
    >
      <div className="lbl flex shrink-0 items-baseline justify-between border-b border-[var(--line)] px-3 py-2">
        <span>commands</span>
        <span className="mono text-[10px] text-[var(--dim)]">{list.length}</span>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {list.map((c, i) => {
          const prev = list[i - 1]
          const gap = prev ? Date.parse(c.at) - Date.parse(prev.at) : 0
          const last = i === list.length - 1
          return (
            <div key={`${c.at}-${i}`} className="relative pb-2.5 pl-4">
              {/* the rail runs between the dots, not past the last one */}
              {!last && <span className="absolute left-[3px] top-[10px] h-full w-px bg-[var(--line)]" aria-hidden />}
              <span
                className="absolute left-0 top-[5px] h-[7px] w-[7px] rounded-full"
                style={{ background: last ? 'var(--accent)' : 'var(--dim)' }}
                aria-hidden
              />
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`mono min-w-0 flex-1 truncate text-[11px] ${last ? 'text-[var(--accent)]' : ''}`}
                  title={`${c.name} · ${new Date(c.at).toLocaleString()}`}
                >
                  {c.name}
                </span>
                <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{clock(c.at)}</span>
              </div>
              {gap > 1000 && <div className="mono text-[9px] text-[var(--dim)]">+{dur(gap)}</div>}
              {last && <div className="mono text-[9px] text-[var(--dim)]">{age(c.at, now)} ago</div>}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

/**
 * The same timeline, turned on its side and stripped back.
 *
 * Sideways there is no room to name every command, and trying reads as clutter rather than as a
 * timeline. So the line keeps only what a glance needs: a dot per command, the newest named at the
 * end, and everything else in a tooltip. The shape still says how the session went — a run of dots
 * is a tight loop, a long gap between them is real work.
 */
export function CommandBar({ list, now }: { list: SessionCommand[]; now: number }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  // which dot is under the pointer, and where it sits in the row
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null)

  useEffect(() => {
    const el = box.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [list.length])

  const newest = list[list.length - 1]
  const at = hover ? list[hover.i] : null
  const gapOf = (i: number): number => (i > 0 ? Date.parse(list[i].at) - Date.parse(list[i - 1].at) : 0)

  return (
    <div ref={row} className="relative flex shrink-0 items-center gap-2.5 border-b border-[var(--line)] py-[7px] pl-4 pr-3">
      <span className="lbl shrink-0">commands</span>

      <div ref={box} className="min-w-0 flex-1 overflow-x-auto">
        <div className="relative flex h-[9px] w-max items-center pr-[1px]">
          {/* one continuous rail behind the dots, rather than a segment between each pair */}
          <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--line)]" aria-hidden />
          {list.map((c, i) => {
            const last = i === list.length - 1
            const on = hover?.i === i
            return (
              <span
                key={`${c.at}-${i}`}
                onMouseEnter={(e) => {
                  // the dots scroll inside their own box, so the tooltip is placed against the row
                  const dot = e.currentTarget.getBoundingClientRect()
                  const bounds = row.current?.getBoundingClientRect()
                  if (bounds) setHover({ i, x: dot.left + dot.width / 2 - bounds.left })
                }}
                onMouseLeave={() => setHover((h) => (h?.i === i ? null : h))}
                className="relative flex h-[9px] w-[13px] shrink-0 cursor-default items-center justify-center"
              >
                <span
                  className="rounded-full transition-transform"
                  style={{
                    width: last ? 7 : 5,
                    height: last ? 7 : 5,
                    background: last ? 'var(--accent)' : on ? 'var(--fg)' : 'var(--dim)',
                    transform: on ? 'scale(1.5)' : undefined,
                    // a dot has to sit on the rail, not float over it
                    boxShadow: last ? '0 0 6px var(--accent)' : '0 0 0 2px var(--ink)'
                  }}
                />
              </span>
            )
          })}
        </div>
      </div>

      {newest && (
        <span className="mono shrink-0 truncate text-[10px] text-[var(--accent)]">{newest.name}</span>
      )}
      <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{list.length}</span>

      {at && hover && (
        <div
          // clamped, so a dot at either end does not push the tooltip off the pane
          style={{ left: Math.max(70, Math.min(hover.x, (row.current?.clientWidth ?? 400) - 70)) }}
          className="pointer-events-none absolute bottom-[calc(100%-4px)] z-40 -translate-x-1/2 whitespace-nowrap rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 shadow-xl"
        >
          <div className="mono text-[11px] text-[var(--fg)]">{at.name}</div>
          <div className="mono text-[9px] text-[var(--dim)]">
            {clock(at.at)}
            {gapOf(hover.i) > 1000 ? ` · ${dur(gapOf(hover.i))} after the one before` : ''}
            {hover.i === list.length - 1 ? ` · ${age(at.at, now)} ago` : ''}
          </div>
        </div>
      )}
    </div>
  )
}
