import { useEffect, useRef, useState } from 'react'
import type { Session, UsageLimit, UsageSnapshot } from '../../../shared/types'
import { averageRate, capped, MIN_POINTS, project, scaleOf, shaped, type Burn, type Sample } from './burnRate'
import { advance, decay, QUIET_MS, type Seen } from './spend'

// long enough to hold several of those whole-percent steps, which is what the coarse signal needs to
// calibrate against; the needle itself is measured over a much shorter span
const WINDOW_MS = 45 * 60 * 1000
// how often a sample is written down: often enough for a six minute measurement, rare enough that
// the persisted list stays small
const EVERY_MS = 10 * 1000
// Nothing here is persisted. The spend counter starts at zero every time the renderer loads and only
// counts growth it has watched, so a sample written by an earlier load carries a number from a
// different counter: 6 points of window against 300k units of "spend since the reload" fits a ratio
// forty times too steep, and the needle goes through the stop. In-memory only, and the window's own
// average covers the minutes until this load can fit its own ratio.

/** The five hour window, which is the one that actually stops you working. */
function sessionLimit(snap: UsageSnapshot | null): UsageLimit | null {
  return snap?.limits.find((l) => l.kind === 'session') ?? null
}

/** The burn, plus the samples behind it, for anything that wants to draw the working out. */
export interface BurnView extends Burn {
  samples: Sample[]
  /** where the window stands right now, which is where a projection starts from */
  pct: number
  /** true when the needle is driven by the token counts rather than by whole-percent steps */
  fine: boolean
  /** tokens are being written but there is no ratio yet to price them against the window */
  warming: boolean
  /** whole points the window has moved since the ratio started being measured, out of the two needed */
  moved: number
  /** ms until the second point lands, at the pace the first one did; null before the first */
  eta: number | null
}

/**
 * How fast the five hour window is going.
 *
 * Two signals, because neither is enough on its own. Claude Code reports the window as a whole
 * number of percent and only rewrites it when a session draws its status line, so it is authoritative
 * and far too slow to watch. The transcripts, which the app is already tailing, carry every token as
 * it is written: fast, continuous, and in units that mean nothing against a rate limit.
 *
 * So the coarse one calibrates the fine one. Percentage points per unit of spend is measured over the
 * whole window, and the needle is that ratio applied to the last few minutes of tokens.
 */
export function useBurn(snap: UsageSnapshot | null, sessions: Session[], now: number): BurnView | null {
  const samples = useRef<Sample[]>([])
  const seen = useRef<Seen>({})
  const spent = useRef(0)
  // the live rate, recomputed on every tick rather than averaged over a window, so the needle is
  // answering the current second
  const perHour = useRef(0)
  const lastTick = useRef(0)
  const lastSpend = useRef(0)
  // when this load started counting, which is what makes an average token rate of its own possible
  const watching = useRef(0)
  // where the ratio is measured from: the first sample of this window, kept outside the 45 minute
  // pruning so a slow burn still accumulates its two points
  const anchor = useRef<Sample | null>(null)
  const [, bump] = useState(0)

  useEffect(() => {
    const limit = sessionLimit(snap)
    if (!limit) return
    const moved = advance(seen.current, sessions)
    seen.current = moved.seen
    spent.current += moved.delta

    const tick = Date.now()
    if (!watching.current) watching.current = tick
    if (lastTick.current) {
      perHour.current = decay(perHour.current, moved.delta, tick - lastTick.current)
      if (moved.delta > 0) lastSpend.current = tick
      // a fleet that has written nothing for a minute and a half is not spending slowly, it stopped
      if (lastSpend.current && tick - lastSpend.current > QUIET_MS) perHour.current = 0
    } else {
      lastSpend.current = tick
    }
    lastTick.current = tick

    const at = Date.now()
    const last = samples.current[samples.current.length - 1]
    // the window resetting is a cliff, not a rate: the ratio measured against the old one is gone
    if (last && limit.percent < last.pct - 1) {
      samples.current = []
      anchor.current = null
    }
    // the anchor is only ever set once per window; everything after it is measured against it
    if (!anchor.current || limit.percent < anchor.current.pct) {
      anchor.current = { at, pct: limit.percent, units: spent.current }
    }
    if (last && at - last.at < EVERY_MS && limit.percent === last.pct) return
    // Payloads are written by whichever session last drew its status line, and a stale one can report
    // a point less than a fresher one. The window only climbs until it resets, so a small step
    // backwards is noise and is held rather than recorded as negative burn.
    const pct = last && limit.percent < last.pct && last.pct - limit.percent <= 5 ? last.pct : limit.percent
    samples.current = [...samples.current, { at, pct, units: spent.current }].filter((s) => at - s.at <= WINDOW_MS)
    bump((n) => n + 1)
  }, [snap, sessions, now])

  const limit = sessionLimit(snap)
  if (!limit) return null

  // Everything is recomputed against the clock rather than against the last payload, so the needle
  // falls on its own when the agents stop: the arrival of a payload cannot be the thing that ends a
  // burn, because a stopped fleet sends none.
  // Measured against this window and no other. A ratio carried over from the previous one is the
  // thing that put the needle in the red 47 minutes after a reset: percentage points per token is
  // only as good as the window it was fitted to, and a fresh window has its own answer within
  // minutes. Until then the window's own average does the job without any calibration at all.
  const scale = scaleOf(anchor.current ? [anchor.current, ...samples.current] : samples.current)
  const since = anchor.current ? now - anchor.current.at : 0
  const moved = anchor.current ? Math.max(0, limit.percent - anchor.current.pct) : 0
  const unitsPerHour = perHour.current
  const fine = scale !== null
  const avg = averageRate(limit.percent, limit.resetsAt, now)
  // this load's own average token rate, which is what the current one is judged against
  const watched = watching.current ? now - watching.current : 0
  const unitsAvg = watched > 5 * 60 * 1000 ? spent.current / (watched / 3_600_000) : 0
  // no tokens being written means no spend, whatever an average over the last hour says
  // Nothing is projected until the window itself can vouch for an average. A five hour outcome
  // cannot be read off three minutes: the percentage has barely moved off zero, so any ratio fitted
  // to it has a lever long enough to put the needle anywhere.
  const rate =
    avg.perHour <= 0
      ? 0
      : fine
        ? capped(scale * unitsPerHour, avg.perHour)
        : unitsPerHour > 0
          ? shaped(avg.perHour, unitsPerHour, unitsAvg)
          : 0

  return {
    ...project(limit.percent, rate, limit.resetsAt, now),
    // tokens are flowing, so this is not idle; it is a rate that cannot be quoted yet
    // only while the window is too young for even an average
    warming: !fine && unitsPerHour > 0 && avg.perHour === 0,
    moved,
    // The first point is the only estimate of how long a point takes, and it is worth using: the
    // second one lands after roughly the same wait. Before it there is nothing to extrapolate from,
    // and a countdown invented from no data is the thing this whole gauge exists to avoid.
    eta: !fine && moved >= 1 && since > 0 ? (since / moved) * (MIN_POINTS - moved) : null,
    spanMs: fine ? Math.min(now - (samples.current[0]?.at ?? now), WINDOW_MS) : avg.spanMs,
    samples: samples.current,
    pct: limit.percent,
    fine
  }
}
