import { useMemo } from 'react'
import type { Session } from '../../../shared/types'
import { age } from '../lib/format'

interface Props {
  sessions: Session[]
  selected: string | null
  now: number
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}

const WINDOW_MS = 30 * 60 * 1000

// every session as a row; its tool calls of the last 30 minutes as bars on one shared time axis
export function FleetWaterfall({ sessions, selected, now, onSelect, onOpen }: Props): JSX.Element {
  const t0 = now - WINDOW_MS
  const rows = useMemo(
    () =>
      sessions.map((s) => {
        const bars: Array<{ start: number; end: number; tool: string }> = []
        let open: { start: number; tool: string } | null = null
        for (const it of s.transcript) {
          const t = Date.parse(it.ts)
          if (it.kind === 'tool') {
            if (open) bars.push({ ...open, end: t })
            open = { start: t, tool: it.tool ?? 'tool' }
          } else if (it.kind === 'result' && open) {
            bars.push({ ...open, end: t })
            open = null
          }
        }
        if (open) bars.push({ ...open, end: now })
        return { s, bars: bars.filter((b) => b.end >= t0) }
      }),
    [sessions, now, t0]
  )
  const ticks = [30, 20, 10, 0]
  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 flex border-b border-[var(--line)] bg-[var(--ink)]">
        <div className="lbl w-[260px] shrink-0 px-4 py-2">session</div>
        <div className="relative flex-1">
          {ticks.map((m) => (
            <span key={m} className="lbl absolute top-2" style={{ left: `${100 - (m / 30) * 100}%`, transform: 'translateX(-50%)' }}>
              -{m}m
            </span>
          ))}
        </div>
      </div>
      {rows.map(({ s, bars }) => (
        <div
          key={s.id}
          onClick={() => onSelect(s.id)}
          onDoubleClick={() => onOpen(s.id)}
          className={`flex cursor-pointer border-b border-[var(--line)] hover:bg-[var(--panel)] ${s.id === selected ? 'bg-[var(--panel)]' : ''}`}
        >
          <div className="w-[260px] shrink-0 px-4 py-2">
            <div className="truncate text-[11px] font-medium">{s.topic ?? s.repo}</div>
            <div className="mono truncate text-[10px] text-[var(--muted)]">
              {s.repo} · {s.state} · {age(s.lastEventAt, now)}
            </div>
          </div>
          <div className="relative flex-1">
            {ticks.map((m) => (
              <span key={m} className="absolute inset-y-0 border-l border-[var(--line)]/60" style={{ left: `${100 - (m / 30) * 100}%` }} />
            ))}
            {bars.map((b, i) => (
              <span
                key={i}
                title={b.tool}
                className="absolute top-[14px] h-[10px] rounded-sm"
                style={{
                  left: `${Math.max(0, ((b.start - t0) / WINDOW_MS) * 100)}%`,
                  width: `${Math.max(0.3, ((b.end - Math.max(b.start, t0)) / WINDOW_MS) * 100)}%`,
                  background: b.tool === 'Bash' ? 'var(--accent)' : b.tool === 'Edit' || b.tool === 'Write' ? '#7aa2f7' : 'var(--muted)'
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
