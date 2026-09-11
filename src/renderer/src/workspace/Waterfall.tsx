import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem } from '../../../shared/types'
import { clock, dur } from '../lib/format'

interface Span {
  tool: string
  start: number
  end: number
  text: string
  open: boolean
}
interface Marker {
  at: number
  text: string
  command: boolean
}

/**
 * Pair each tool call with the result carrying its id; a call with no result yet runs to `now`.
 * Calls issued together are answered together, so the next result belongs to whichever call it
 * names, not to the one that happens to be open.
 */
function spans(items: TranscriptItem[], now: number): Span[] {
  const out: Span[] = []
  const byToolUseId = new Map<string, Span>()
  let last: Span | null = null
  for (const it of items) {
    const t = Date.parse(it.ts)
    if (it.kind === 'tool') {
      const span: Span = { tool: it.tool ?? 'tool', start: t, end: t, text: it.text, open: true }
      out.push(span)
      last = span
      if (it.toolUseId) byToolUseId.set(it.toolUseId, span)
    } else if (it.kind === 'result') {
      // an item parsed before toolUseId existed carries no id, so it closes the most recent call
      const span = it.toolUseId ? byToolUseId.get(it.toolUseId) : last
      if (span?.open) {
        span.end = t
        span.open = false
      }
    }
  }
  for (const s of out) if (s.open) s.end = now
  return out
}

// one lane per kind of work, so vertical position carries meaning
const LANES = [
  { key: 'run', label: 'Run', color: 'var(--accent)', tools: ['Bash', 'BashOutput', 'KillShell'] },
  { key: 'edit', label: 'Edit', color: '#7aa2f7', tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] },
  { key: 'read', label: 'Read', color: '#8a93a3', tools: ['Read', 'Grep', 'Glob', 'LS'] },
  { key: 'web', label: 'Web', color: '#f7768e', tools: ['WebFetch', 'WebSearch'] },
  { key: 'agent', label: 'Agents', color: '#bb9af7', tools: ['Agent', 'Task', 'SendMessage'] },
  { key: 'other', label: 'Other', color: '#e0af68', tools: [] }
] as const

const RANGES = [
  { label: '5m', ms: 5 * 60_000 },
  { label: '30m', ms: 30 * 60_000 },
  { label: '2h', ms: 2 * 3600_000 },
  { label: 'all', ms: 0 }
]

const GUTTER = 62
const MIN_BAR = 8
const AXIS = 16
const HEADER = 22
// breathing room under the lowest lane so the bars never sit on the window edge
const FLOOR = 26
// below this there is not enough room for a lane, an axis and a readable bar
const LANES_MIN = 86

function laneOf(tool: string): (typeof LANES)[number] {
  return LANES.find((l) => (l.tools as readonly string[]).includes(tool)) ?? LANES[LANES.length - 1]
}

export function Waterfall({
  items,
  now,
  height: boxH,
  sessionId
}: {
  items: TranscriptItem[]
  now: number
  height: number
  sessionId: string
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [rangeIdx, setRangeIdx] = useState(1)

  // Claude Code flushes its transcript in bursts, so a call can be seconds old before it lands in
  // the log. The hooks fire the moment a tool starts and the moment it returns, which is what makes
  // this pane live rather than lagging.
  const [hookSpans, setHookSpans] = useState<Span[]>([])
  useEffect(() => {
    setHookSpans([])
    return window.api.hooks.onHookEvent((e) => {
      if (e.session_id !== sessionId) return
      const at = Date.parse(e.at)
      if (e.event === 'PreToolUse') {
        setHookSpans((prev) => [...prev.slice(-40), { tool: e.tool_name ?? 'tool', start: at, end: at, text: '', open: true }])
      } else if (e.event === 'PostToolUse') {
        setHookSpans((prev) => {
          const next = [...prev]
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].open && next[i].tool === (e.tool_name ?? next[i].tool)) {
              next[i] = { ...next[i], end: at, open: false }
              break
            }
          }
          return next
        })
      }
    })
  }, [sessionId])

  const allSpans = useMemo(() => {
    const logged = spans(items, now)
    // once the log catches up it is the better record, so only keep hook spans newer than it
    const cutoff = logged.length ? logged[logged.length - 1].start : 0
    const live = hookSpans.filter((h) => h.start > cutoff)
    return [...logged, ...live]
  }, [items, now, hookSpans])
  const allMarks = useMemo<Marker[]>(
    () =>
      items
        .filter((it) => it.kind === 'prompt' || it.kind === 'command')
        .map((it) => ({ at: Date.parse(it.ts), text: it.text, command: it.kind === 'command' })),
    [items]
  )

  // No switch for this. The strip exists because the pane is short, so the pane's own height is the
  // setting: drag the divider down, or double click it, and the lanes give way to one line of dots.
  const strip = boxH < LANES_MIN
  const range = RANGES[rangeIdx]
  const earliest = allSpans.length ? allSpans[0].start : now
  const t0 = range.ms ? Math.max(earliest, now - range.ms) : earliest
  const t1 = Math.max(now, ...allSpans.map((s) => s.end))
  const W = Math.max(1000, t1 - t0)

  const shown = allSpans.filter((s) => s.end >= t0)
  const marks = allMarks.filter((m) => m.at >= t0)
  const lanes = useMemo(() => {
    const used = new Map<string, number>()
    for (const s of shown) used.set(laneOf(s.tool).key, (used.get(laneOf(s.tool).key) ?? 0) + 1)
    return LANES.filter((l) => used.has(l.key)).map((l) => ({ ...l, count: used.get(l.key)! }))
  }, [shown])

  if (!allSpans.length) return null
  const pct = (t: number): number => ((t - t0) / W) * 100
  const rowOf = (tool: string): number => Math.max(0, lanes.findIndex((l) => l.key === laneOf(tool).key))
  const active = hover !== null ? shown[hover] : null
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  // lanes share whatever height the divider leaves, so dragging the pane taller makes bars readable
  const height = Math.max(40, boxH - HEADER - FLOOR)
  const ROW = Math.max(14, Math.min(56, (height - AXIS) / Math.max(1, lanes.length)))
  const BAR_H = Math.max(8, Math.min(26, ROW - 8))

  return (
    <div className={`relative flex h-full shrink-0 flex-col px-5 pt-1.5 ${strip ? 'pb-1' : 'pb-5'}`}>
      <div className={`flex items-baseline justify-between gap-4 ${strip ? 'mb-0.5' : 'mb-1'}`}>
        <span className="lbl">
          timeline · {shown.length} tool calls{marks.length ? ` · ${marks.length} prompts` : ''}
        </span>
        <span className="flex items-center gap-1">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setRangeIdx(i)}
              className={`lbl rounded px-1.5 py-0.5 ${i === rangeIdx ? 'bg-[var(--accent-soft)] !text-[var(--accent)]' : 'hover:!text-[var(--fg)]'}`}
            >
              {r.label}
            </button>
          ))}
        </span>
      </div>

      {strip ? (
        <Strip spans={shown} now={now} />
      ) : (
      <div ref={ref} className="relative min-h-0 flex-1" style={{ height }} onMouseLeave={() => setHover(null)}>
        {/* axis: wall-clock labels, so the row lines up with what happened when */}
        <div className="absolute top-0" style={{ left: GUTTER, right: 0, height: AXIS }}>
          {ticks.map((f) => (
            <span
              key={f}
              className="mono absolute top-0 text-[8.5px] leading-none text-[var(--dim)]"
              style={{ left: `${f * 100}%`, transform: f === 1 ? 'translateX(-100%)' : f === 0 ? 'none' : 'translateX(-50%)' }}
            >
              {clock(new Date(t0 + W * f).toISOString()).slice(0, 5)}
            </span>
          ))}
        </div>
        {ticks.map((f) => (
          <span
            key={`g${f}`}
            className="absolute border-l border-[var(--line)]"
            style={{ left: `calc(${GUTTER}px + (100% - ${GUTTER}px) * ${f})`, top: AXIS, bottom: 0, opacity: 0.45 }}
          />
        ))}

        {lanes.map((l, i) => (
          <span
            key={l.key}
            className="mono absolute left-0 flex w-[54px] items-center gap-1 text-[9px] text-[var(--muted)]"
            style={{ top: AXIS + i * ROW + (ROW - 10) / 2 }}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: l.color }} />
            {l.label}
            <span className="text-[var(--dim)]">{l.count}</span>
          </span>
        ))}

        {/* a call that began before the visible range still has to be drawn, and its own left edge is
            off the scale: clipped here as well as clamped below, because an absolutely positioned bar
            has no ancestor to stop it painting across the rest of the window */}
        <div className="absolute overflow-hidden" style={{ left: GUTTER, right: 0, top: AXIS, bottom: 0 }}>
          {/* every prompt is a milestone: the work to its right is the answer to it */}
          {marks.map((m, i) => (
            <span key={`m${i}`} className="absolute inset-y-0" style={{ left: `${pct(m.at)}%` }} title={m.text}>
              <span className="absolute inset-y-0 w-px" style={{ background: m.command ? '#e0af68' : 'var(--fg)', opacity: 0.5 }} />
              <span
                className="absolute -top-[5px] -left-[3px] h-0 w-0"
                style={{
                  borderLeft: '3.5px solid transparent',
                  borderRight: '3.5px solid transparent',
                  borderTop: `5px solid ${m.command ? '#e0af68' : 'var(--fg)'}`
                }}
              />
            </span>
          ))}

          {shown.map((s, i) => {
            const lane = laneOf(s.tool)
            // it runs from before the window, so it starts at the edge and says so by losing the
            // rounding on that side
            const cut = s.start < t0
            const left = pct(Math.max(s.start, t0))
            const width = Math.max(0.2, pct(s.end) - left)
            const on = hover === i
            return (
              <div
                key={i}
                onMouseEnter={() => setHover(i)}
                className="absolute cursor-default rounded-[3px]"
                style={{
                  left: `${left}%`,
                  width: `max(${width}%, ${MIN_BAR}px)`,
                  top: rowOf(s.tool) * ROW + (ROW - BAR_H) / 2,
                  height: BAR_H,
                  background: lane.color,
                  borderTopLeftRadius: cut ? 0 : undefined,
                  borderBottomLeftRadius: cut ? 0 : undefined,
                  opacity: on ? 1 : s.open ? 0.95 : 0.72,
                  boxShadow: on ? '0 0 0 1.5px var(--fg)' : undefined
                }}
              />
            )
          })}

          <span className="absolute inset-y-0 right-0 w-px bg-[var(--accent)] opacity-70" />
        </div>
      </div>
      )}

      {!strip && active && <Tip s={active} left={pct(active.start)} color={laneOf(active.tool).color} />}
    </div>
  )
}

/**
 * The same calls as one line of dots, coloured by what kind of work each was.
 *
 * Reads like the command bar above the chat on purpose: at a glance the shape says how the turn went
 * — a run of green is a shell loop, a blue cluster is an edit pass, a long gap is thinking. What each
 * dot was belongs in the tooltip, because a name per dot at this width is unreadable.
 */
function Strip({ spans, now }: { spans: Span[]; now: number }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null)

  useEffect(() => {
    const el = box.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [spans.length])

  const at = hover ? spans[hover.i] : null
  const gapOf = (i: number): number => (i > 0 ? spans[i].start - spans[i - 1].end : 0)

  return (
    <div ref={row} className="relative flex min-h-0 flex-1 items-center gap-2.5">
      <div ref={box} className="min-w-0 flex-1 overflow-x-auto">
        <div className="relative flex h-[11px] w-max items-center pr-[1px]">
          <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--line)]" aria-hidden />
          {spans.map((s, i) => {
            const lane = laneOf(s.tool)
            const on = hover?.i === i
            return (
              <span
                key={i}
                onMouseEnter={(e) => {
                  // the dots scroll in their own box, so the tooltip is placed against the row
                  const dot = e.currentTarget.getBoundingClientRect()
                  const bounds = row.current?.getBoundingClientRect()
                  if (bounds) setHover({ i, x: dot.left + dot.width / 2 - bounds.left })
                }}
                onMouseLeave={() => setHover((h) => (h?.i === i ? null : h))}
                className="relative flex h-[11px] w-[13px] shrink-0 cursor-default items-center justify-center"
              >
                <span
                  className="rounded-full transition-transform"
                  style={{
                    width: s.open ? 7 : 5,
                    height: s.open ? 7 : 5,
                    background: lane.color,
                    opacity: on || s.open ? 1 : 0.75,
                    transform: on ? 'scale(1.5)' : undefined,
                    boxShadow: s.open ? `0 0 6px ${lane.color}` : '0 0 0 2px var(--ink)'
                  }}
                />
              </span>
            )
          })}
        </div>
      </div>

      <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{spans.length}</span>

      {at && hover && (
        <div
          style={{ left: Math.max(80, Math.min(hover.x, (row.current?.clientWidth ?? 400) - 80)) }}
          className="pointer-events-none absolute bottom-[calc(100%-2px)] z-40 -translate-x-1/2 max-w-[340px] rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 shadow-xl"
        >
          <div className="mono truncate text-[11px]" style={{ color: laneOf(at.tool).color }}>
            {at.tool}
          </div>
          <div className="mono truncate text-[9px] text-[var(--dim)]">
            {at.open ? 'still running' : dur(at.end - at.start)} · {clock(new Date(at.start).toISOString())}
            {gapOf(hover.i) > 2000 ? ` · ${dur(gapOf(hover.i))} idle before` : ''}
          </div>
          {at.text && <div className="mono mt-0.5 truncate text-[9.5px] text-[var(--muted)]">{at.text}</div>}
        </div>
      )}
    </div>
  )
}

function Tip({ s, left, color }: { s: Span; left: number; color: string }): JSX.Element {
  // keep the card inside the pane instead of letting it hang off an edge
  const shift = left < 18 ? '0%' : left > 82 ? '-100%' : '-50%'
  return (
    <div
      className="pointer-events-none absolute bottom-[calc(100%-8px)] z-20 w-[340px] rounded-md border border-[var(--line)] bg-[var(--raised)] px-3 py-2 shadow-2xl"
      style={{ left: `calc(${GUTTER}px + ${left}% * 0.9)`, transform: `translateX(${shift})` }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="mono text-[11px] font-semibold" style={{ color }}>
          {s.tool}
        </span>
        <span className="mono text-[10px] text-[var(--muted)]">
          {s.open ? 'still running' : dur(s.end - s.start)} · started {clock(new Date(s.start).toISOString())}
        </span>
      </div>
      <div className="mono mt-1 max-h-[80px] overflow-hidden whitespace-pre-wrap break-words text-[10.5px] leading-snug text-[var(--muted)]">
        {s.text || '—'}
      </div>
    </div>
  )
}
