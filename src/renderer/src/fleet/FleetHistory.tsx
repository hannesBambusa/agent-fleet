import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '../../../shared/types'
import { clock, dur, tokens } from '../lib/format'

interface Props {
  sessions: Session[]
  selected: string | null
  now: number
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}

const WINDOWS = [1, 3, 6, 12, 24]
const GUTTER = 190
const ROW = 52
const GROUP_PAD = 26
const TOP = 34
const COLORS = ['#bb9af7', '#7aa2f7', '#5ee0a0', '#f2b84b', '#f7768e', '#7dcfff', '#c0caf5', '#e0af68']

function colorFor(type: string): string {
  let h = 0
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

interface Node {
  s: Session
  start: number
  end: number
  live: boolean
  x: number
  y: number
  r: number
  endX: number
  color: string
  label: string
}
interface Group {
  root: Session
  y: number
  height: number
  rootNode: Node | null
  kids: Node[]
}

// a run laid out on a time axis: circles are agents, the track behind each is how long it worked
export function FleetHistory({ sessions, selected, now, onSelect, onOpen }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    setW(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  const { groups, height, hours, t0 } = useMemo(() => {
    const subs = sessions.filter((s) => s.parentId && s.firstEventAt)
    const spanH = subs.length ? (now - Math.min(...subs.map((s) => Date.parse(s.firstEventAt!)))) / 3600000 : 1
    const hours = WINDOWS.find((h) => h >= spanH) ?? 24
    const t0 = now - hours * 3600000
    const span = hours * 3600000
    const usable = Math.max(120, w - GUTTER - 90)
    const xOf = (t: number): number => GUTTER + Math.max(0, Math.min(1, (t - t0) / span)) * usable
    const radius = (s: Session): number => {
      const out = s.tokens.output
      return 6 + Math.min(7, Math.max(0, Math.log10(Math.max(10, out)) - 1) * 2.4)
    }
    const make = (s: Session): Node => {
      const start = Date.parse(s.firstEventAt!)
      const end = s.lastEventAt ? Date.parse(s.lastEventAt) : start
      return {
        s,
        start,
        end,
        live: s.state === 'running' || s.state === 'waiting',
        x: xOf(start),
        y: 0,
        r: radius(s),
        endX: xOf(end),
        color: colorFor(s.agentType ?? (s.parentId ? 'agent' : 'session')),
        label: s.topic ?? s.lastPrompt?.split('\n')[0]?.slice(0, 40) ?? 'agent'
      }
    }

    const byRoot = new Map<string, Session[]>()
    for (const s of subs) byRoot.set(s.parentId!, [...(byRoot.get(s.parentId!) ?? []), s])
    const rootOf = new Map(sessions.filter((s) => !s.parentId).map((s) => [s.id, s]))

    let y = TOP
    const groups: Group[] = [...byRoot.entries()]
      .map(([rootId, list]) => ({ rootId, list: list.slice().sort((a, b) => Date.parse(a.firstEventAt!) - Date.parse(b.firstEventAt!)) }))
      .filter((g) => g.list.some((s) => (s.lastEventAt ? Date.parse(s.lastEventAt) : 0) >= t0))
      // newest run at the top, keyed on when the run started so rows do not jump while it works
      .sort((a, b) => Date.parse(b.list[0].firstEventAt ?? '0') - Date.parse(a.list[0].firstEventAt ?? '0'))
      .map(({ rootId, list }) => {
        const kids = list.map(make)
        kids.forEach((n, i) => (n.y = y + i * ROW + ROW / 2))
        const height = list.length * ROW
        const root = rootOf.get(rootId)
        let rootNode: Node | null = null
        if (root?.firstEventAt) {
          rootNode = make(root)
          rootNode.r = 11
          rootNode.color = '#8a93a3'
          rootNode.y = y + height / 2
          rootNode.x = Math.min(rootNode.x, kids.length ? Math.min(...kids.map((k) => k.x)) - 46 : rootNode.x)
          rootNode.x = Math.max(GUTTER - 34, rootNode.x)
        }
        const g: Group = { root: root ?? list[0], y, height, rootNode, kids }
        y += height + GROUP_PAD
        return g
      })
    return { groups, height: Math.max(y, 200), hours, t0 }
  }, [sessions, now, w])

  const ticks = Array.from({ length: 7 }, (_, i) => Math.round((hours * (6 - i)) / 6))
  const xOfTick = (h: number): number => GUTTER + (1 - h / hours) * Math.max(120, w - GUTTER - 90)

  if (!groups.length) {
    return (
      <div ref={ref} className="flex h-full items-center justify-center text-[12px] text-[var(--dim)]">
        no subagent runs in the last {hours}h
      </div>
    )
  }
  return (
    <div ref={ref} className="h-full overflow-auto overscroll-contain">
      <svg width={Math.max(w, 640)} height={height} className="block">
        <defs>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {ticks.map((h, i) => (
          <g key={i}>
            <line x1={xOfTick(h)} y1={22} x2={xOfTick(h)} y2={height} stroke="var(--line)" strokeOpacity={0.5} />
            <text x={xOfTick(h)} y={15} textAnchor="middle" className="fill-[var(--dim)] text-[9px] uppercase tracking-widest">
              {h === 0 ? 'now' : `-${h}h`}
            </text>
          </g>
        ))}

        {groups.map((g) => (
          <g key={g.root.id}>
            <text x={12} y={g.y + 14} className="fill-[var(--fg)] text-[11px] font-medium">
              {(g.root.topic ?? g.root.repo).slice(0, 24)}
            </text>
            <text x={12} y={g.y + 27} className="fill-[var(--dim)] text-[9px] uppercase tracking-widest">
              {g.root.repo} · {g.kids.length} subagents
            </text>

            {g.rootNode &&
              g.kids.map((k) => (
                <path
                  key={`e-${k.s.id}`}
                  d={`M ${g.rootNode!.x + g.rootNode!.r} ${g.rootNode!.y} C ${g.rootNode!.x + 40} ${g.rootNode!.y}, ${k.x - 40} ${k.y}, ${k.x - k.r - 2} ${k.y}`}
                  fill="none"
                  stroke={k.s.id === selected ? k.color : 'var(--line)'}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
              ))}

            {g.rootNode && (
              <g>
                <circle cx={g.rootNode.x} cy={g.rootNode.y} r={g.rootNode.r} fill="var(--raised)" stroke="var(--muted)" strokeWidth={1.2} />
                <text x={g.rootNode.x} y={g.rootNode.y + 3.5} textAnchor="middle" className="fill-[var(--muted)] text-[9px]">
                  ●
                </text>
              </g>
            )}

            {g.kids.map((k) => (
              <g
                key={k.s.id}
                className="cursor-pointer"
                onMouseEnter={() => onSelect(k.s.id)}
                onClick={() => onOpen(k.s.id)}
              >
                <line
                  x1={k.x}
                  y1={k.y}
                  x2={Math.max(k.endX, k.x + 2)}
                  y2={k.y}
                  stroke={k.color}
                  strokeOpacity={k.live ? 0.9 : 0.45}
                  strokeWidth={k.s.id === selected ? 7 : 5}
                  strokeLinecap="round"
                />
                <circle
                  cx={k.x}
                  cy={k.y}
                  r={k.r}
                  fill="var(--ink)"
                  stroke={k.color}
                  strokeWidth={k.s.id === selected ? 2.4 : 1.6}
                  filter={k.live ? 'url(#glow)' : undefined}
                  className={k.live ? 'node-breathe' : undefined}
                />
                <text x={k.x} y={k.y + 3.5} textAnchor="middle" style={{ fill: k.color }} className="text-[9px] font-semibold">
                  {(k.s.agentType ?? 'a').slice(0, 1).toUpperCase()}
                </text>
                <text x={Math.max(k.endX, k.x + k.r) + 10} y={k.y - 2} className="fill-[var(--fg)] text-[10.5px]">
                  {k.label.slice(0, 42)}
                </text>
                <text x={Math.max(k.endX, k.x + k.r) + 10} y={k.y + 10} className="fill-[var(--dim)] text-[9px]">
                  {k.s.agentType ?? 'agent'} · {dur(k.end - k.start)} · {tokens(k.s.tokens.output)} out · {clock(k.s.firstEventAt!)}
                </text>
                <rect x={GUTTER - 8} y={k.y - ROW / 2} width={Math.max(0, w - GUTTER)} height={ROW} fill="transparent" />
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  )
}
