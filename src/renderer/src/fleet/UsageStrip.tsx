import type { Session, UsageLimit, UsageSnapshot } from '../../../shared/types'
import { dur, tokens } from '../lib/format'
import { MIN_POINTS } from '../state/burnRate'
import { useBurn, type BurnView as BurnRate } from '../state/burn'

// Fallback only: used when no status-line payload has arrived for the session yet. Every current
// model is 1M, and a live payload carries the real size anyway.
const CONTEXT_WINDOW = 1_000_000

function color(percent: number, severity?: string): string {
  if (severity === 'critical' || percent >= 95) return '#e34948'
  if (severity === 'warning' || percent >= 80) return '#eda100'
  return 'var(--accent)'
}

function until(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  return ms > 0 ? dur(ms) : 'now'
}

function label(l: UsageLimit): string {
  if (l.kind === 'session') return '5h'
  if (l.kind === 'weekly_all') return '7d'
  return l.label
}

/**
 * The same four numbers the status line carries, kept in view while you work: how full the context
 * of the session you are looking at is, and how much of the plan's windows is spent.
 */
export function UsageStrip({
  snap,
  session,
  sessions,
  now
}: {
  snap: UsageSnapshot | null
  session: Session | null
  /** every session the tailer knows, which is where the live token counts come from */
  sessions: Session[]
  now: number
}): JSX.Element | null {
  const burn = useBurn(snap, sessions, now)
  const limits = snap?.limits ?? []
  // the session's own status-line payload knows both numbers exactly; the transcript total is a guess
  const liveCtx = session ? snap?.contexts[session.id] : undefined
  const ctx = liveCtx?.tokens || (session?.context ?? 0)
  const size = liveCtx?.size || CONTEXT_WINDOW
  const ctxPct = liveCtx?.percent ?? Math.min(100, Math.round((ctx / size) * 100))
  if (!limits.length && !ctx) return null

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-[var(--line)] px-4 py-1.5">
      {!!ctx && (
        <Gauge
          name="ctx"
          percent={ctxPct}
          tone={color(ctxPct)}
          right={`${tokens(ctx)} / ${tokens(size)}`}
          title={`context in use by ${session?.topic ?? session?.repo ?? 'this session'}`}
        />
      )}
      {snap && (
        <span
          className="flex items-center gap-1.5"
          title={snap.caveman ? `caveman skill active · ${snap.caveman}` : 'caveman skill is off'}
        >
          <span className="lbl">caveman</span>
          <span
            className="mono rounded px-1.5 py-0.5 text-[10px]"
            style={
              snap.caveman
                ? { color: '#d95926', background: 'rgba(217,89,38,0.14)' }
                : { color: 'var(--dim)', background: 'var(--raised)' }
            }
          >
            {snap.caveman ? `[o_o] ${snap.caveman}` : '[-_-] off'}
          </span>
        </span>
      )}
      {/* always on show once the window is known: a speed of zero is an answer, and a gauge that
          vanishes when the fleet goes quiet is the moment you most want to see it reading zero */}
      {burn && <Burn burn={burn} />}
      {limits.map((l) => (
        <Gauge
          key={l.key}
          name={label(l)}
          percent={l.percent}
          tone={color(l.percent, l.severity)}
          right={l.resetsAt ? `↺${until(l.resetsAt)}` : ''}
          title={`${l.label} · ${l.percent}% used${l.resetsAt ? ` · resets in ${until(l.resetsAt)}` : ''}`}
        />
      ))}
    </div>
  )
}

function Gauge({
  name,
  percent,
  tone,
  right,
  title
}: {
  name: string
  percent: number
  tone: string
  right: string
  title: string
}): JSX.Element {
  return (
    <span className="flex items-center gap-2" title={title}>
      <span className="lbl w-[34px] shrink-0">{name}</span>
      <span className="h-[6px] w-[76px] shrink-0 overflow-hidden rounded-full bg-[var(--raised)]">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(percent, 2)}%`, background: tone }} />
      </span>
      <span className="mono w-[34px] shrink-0 text-[10px]" style={{ color: tone }}>
        {percent}%
      </span>
      {right && <span className="mono text-[9.5px] text-[var(--dim)]">{right}</span>}
    </span>
  )
}

/**
 * Whether the five hour window runs out before it resets, as a dial.
 *
 * There is a speed the window can be spent at and still last: whatever is left, divided by the time
 * until it resets. That rate is the redline, and it moves on its own as the window drains, so the
 * only question worth a glance is which side of it the needle sits on. Inside the green, the work
 * you start now finishes; past it, the tokens run out first.
 */
function Burn({ burn }: { burn: BurnRate }): JSX.Element {
  const W = 46
  const H = 26
  const cx = W / 2
  const cy = H - 4
  const r = 16

  const idle = !burn.measured
  const redline = burn.needRate ?? 0
  // The redline is the end of the dial, so the needle reads as a fraction of what can be afforded:
  // spending half of what the window allows puts it at half. Past the end there is nowhere to go,
  // so it pegs and says so rather than quietly rescaling under you.
  const full = Math.max(redline, 0.5)
  const share = full > 0 ? burn.perHour / full : 0
  const over = burn.capsFirst || share > 1
  // Nothing under the redline is a problem, so nothing under it is painted as one: the only colour
  // that means trouble is the needle's own. A red band inside the affordable range says "danger"
  // while the words say "ok", and the picture is the half people believe.
  const tone = burn.warming ? 'var(--accent)' : idle ? 'var(--dim)' : over ? 'var(--danger)' : share > 0.85 ? 'var(--warn)' : 'var(--accent)'

  // a half turn, left to right
  const at = (rate: number): number => Math.PI - Math.min(1, rate / full) * Math.PI
  const pt = (rate: number, rad: number): [number, number] => {
    const a = at(rate)
    return [cx + Math.cos(a) * rad, cy - Math.sin(a) * rad]
  }
  const arc = (from: number, to: number): string => {
    const [x1, y1] = pt(from, r)
    const [x2, y2] = pt(to, r)
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }
  // the needle is always on the dial, resting at zero when nothing is being spent: a gauge that
  // disappears when the engine idles tells you nothing about whether it is idling
  const [nx, ny] = pt(burn.perHour, r - 3)

  return (
    <span className="flex items-center gap-1.5" title={titleOf(burn)}>
      <span className="lbl">burn</span>
      <svg width={W} height={H} className="shrink-0 overflow-visible" aria-hidden>
        <path d={arc(0, full)} fill="none" stroke="var(--line)" strokeWidth={3} strokeLinecap="round" />
        {/* how much of the allowance the current speed uses, swept from the left */}
        {!idle && (
          <path
            d={arc(0, Math.min(burn.perHour, full))}
            fill="none"
            stroke={tone}
            strokeOpacity={0.45}
            strokeWidth={3}
            strokeLinecap="round"
          />
        )}
        <line
          x1={cx}
          y1={cy}
          x2={nx}
          y2={ny}
          stroke={tone}
          strokeWidth={1.5}
          strokeLinecap="round"
          style={{ transition: 'all 600ms ease-out' }}
        />
        <circle cx={cx} cy={cy} r={2} fill={tone} />
        {/* past the end of the dial: the needle is at the stop, and this says it is not the truth */}
        {share > 1 && (
          <polygon points={`${W - 1},${cy - r - 1} ${W + 4},${cy - r + 2} ${W - 1},${cy - r + 5}`} fill="var(--danger)" />
        )}
      </svg>
      <span className="mono shrink-0 text-[10px]" style={{ color: tone }}>
        {burn.warming ? (burn.eta !== null ? `measuring ${dur(burn.eta)}` : `measuring ${burn.moved}/2`) : idle ? 'idle' : burn.capsFirst ? `full ${dur(burn.earlyBy ?? 0)} early` : share > 0.85 ? 'tight' : 'ok'}
      </span>
    </span>
  )
}

/** The arithmetic, for anyone who wants to check the dial. */
function titleOf(burn: BurnRate): string {
  const bar = burn.needRate !== null ? `redline ${burn.needRate.toFixed(1)}%/h` : 'no reset time known'
  const from = burn.fine ? 'from the tokens being written' : "from the window's own whole-percent steps"
  if (burn.warming) {
    const head = `working out what a token costs against this window: ${burn.moved} of ${MIN_POINTS} points so far`
    return burn.eta !== null
      ? `${head}, about ${dur(burn.eta)} to go at this pace · measured once, then remembered · ${bar}`
      : `${head} · the first point is what sets the pace, so there is nothing to count down from yet · ${bar}`
  }
  if (!burn.measured) return `nothing being spent · ${bar}`
  const head = `${burn.perHour.toFixed(1)}%/h of the 5 hour window ${from} · ${bar}`
  if (burn.capsFirst) {
    return `${head} · full in ${dur(burn.toCap ?? 0)}, which is ${dur(burn.earlyBy ?? 0)} before it resets`
  }
  return `${head} · inside the redline, so it lasts until the reset`
}
