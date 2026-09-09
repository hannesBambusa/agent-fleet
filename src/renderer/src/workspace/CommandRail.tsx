import { useEffect, useRef } from 'react'
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
