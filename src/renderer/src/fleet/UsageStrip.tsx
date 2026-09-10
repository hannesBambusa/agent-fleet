import type { Session, UsageLimit, UsageSnapshot } from '../../../shared/types'
import { dur, tokens } from '../lib/format'
import { useBurn, type Burn as BurnRate } from '../state/burn'

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
  now
}: {
  snap: UsageSnapshot | null
  session: Session | null
  now: number
}): JSX.Element | null {
  const burn = useBurn(snap, now)
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
      {burn && burn.spanMs > 0 && <Burn burn={burn} />}
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
 * Whether the five hour window runs out before it resets.
 *
 * The only question the rate answers that changes anything, so it is answered in one figure and one
 * colour: green means the window turns over before the limit does, red means it does not and says
 * when, grey means nothing is being spent. Everything behind it is on hover, where it costs no
 * space. Nothing at all is shown until there are enough samples to mean something.
 */
function Burn({ burn }: { burn: BurnRate }): JSX.Element {
  // below this a rate is noise: a poll landing either side of a token or two, not work
  const idle = burn.perHour <= 0.5
  const bad = burn.capsFirst
  return (
    <span
      className="flex items-center gap-1.5"
      title={
        idle
          ? `nothing spent in the last ${dur(burn.spanMs)}`
          : `${burn.perHour.toFixed(1)}% of the 5 hour window per hour, over the last ${dur(burn.spanMs)}` +
            (bad
              ? ` · full ${dur(burn.earlyBy ?? 0)} before it resets`
              : burn.needRate !== null
                ? ` · it would take ${burn.needRate.toFixed(0)}%/h to run out first`
                : '')
      }
    >
      <span className="lbl">burn</span>
      <span
        className="mono text-[10px] font-medium"
        style={{ color: idle ? 'var(--dim)' : bad ? 'var(--danger)' : 'var(--accent)' }}
      >
        {idle ? 'idle' : bad ? `full in ${dur(burn.toCap ?? 0)}` : 'ok'}
      </span>
    </span>
  )
}
