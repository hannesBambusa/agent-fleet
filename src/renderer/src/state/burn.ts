import { useEffect, useRef, useState } from 'react'
import type { Session, UsageLimit, UsageSnapshot } from '../../../shared/types'
import { readPersisted, writePersisted } from './store'
import { MIN_POINTS, project, rateOf, scaleOf, settle, stalled, type Burn, type Sample } from './burnRate'
import { advance, decay, QUIET_MS, type Seen } from './spend'

// long enough to hold several of those whole-percent steps, which is what the coarse signal needs to
// calibrate against; the needle itself is measured over a much shorter span
const WINDOW_MS = 45 * 60 * 1000
// how often a sample is written down: often enough for a six minute measurement, rare enough that
// the persisted list stays small
const EVERY_MS = 10 * 1000
const KEY = 'usageSamples'
// The ratio is a property of the account's plan, not of this window, so it is worth keeping: a fresh
// start or a reset would otherwise spend its first twenty minutes unable to say anything.
const SCALE_KEY = 'usageScale'
// Where the ratio is measured from. Deliberately outside the 45 minute sample window: a slow burn
// takes longer than that to move the window two whole points, and pruning the far end away is how a
// quiet fleet would stay uncalibrated for ever.
const ANCHOR_KEY = 'usageAnchor'

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
  const samples = useRef<Sample[]>(readPersisted<Sample[]>(KEY, []))
  const seen = useRef<Seen>({})
  const spent = useRef(0)
  // the live rate, recomputed on every tick rather than averaged over a window, so the needle is
  // answering the current second
  const perHour = useRef(0)
  const lastTick = useRef(0)
  const lastSpend = useRef(0)
  const known = useRef<number | null>(readPersisted<number | null>(SCALE_KEY, null))
  const anchor = useRef<Sample | null>(readPersisted<Sample | null>(ANCHOR_KEY, null))
  const [, bump] = useState(0)

  useEffect(() => {
    const limit = sessionLimit(snap)
    if (!limit) return
    const moved = advance(seen.current, sessions)
    seen.current = moved.seen
    spent.current += moved.delta

    const tick = Date.now()
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
      writePersisted(ANCHOR_KEY, anchor.current)
    }
    if (last && at - last.at < EVERY_MS && limit.percent === last.pct) return
    // Payloads are written by whichever session last drew its status line, and a stale one can report
    // a point less than a fresher one. The window only climbs until it resets, so a small step
    // backwards is noise and is held rather than recorded as negative burn.
    const pct = last && limit.percent < last.pct && last.pct - limit.percent <= 5 ? last.pct : limit.percent
    samples.current = [...samples.current, { at, pct, units: spent.current }].filter((s) => at - s.at <= WINDOW_MS)
    writePersisted(KEY, samples.current)
    bump((n) => n + 1)
  }, [snap, sessions, now])

  const limit = sessionLimit(snap)
  if (!limit) return null

  // Everything is recomputed against the clock rather than against the last payload, so the needle
  // falls on its own when the agents stop: the arrival of a payload cannot be the thing that ends a
  // burn, because a stopped fleet sends none.
  // a ratio measured now beats one remembered, but the remembered one is what makes the gauge useful
  // in the first minutes after a start or a reset
  const measured = scaleOf(anchor.current ? [anchor.current, ...samples.current] : samples.current)
  if (measured !== null && measured !== known.current) {
    known.current = measured
    writePersisted(SCALE_KEY, measured)
  }
  const scale = measured ?? known.current
  const since = anchor.current ? now - anchor.current.at : 0
  const moved = anchor.current ? Math.max(0, limit.percent - anchor.current.pct) : 0
  const unitsPerHour = perHour.current
  const fine = scale !== null
  const coarse = settle(samples.current, now, WINDOW_MS)
  const slow = rateOf(coarse)
  const rate = fine
    ? scale * unitsPerHour
    : stalled(coarse, now)
      ? 0
      : slow.perHour

  return {
    ...project(limit.percent, rate, limit.resetsAt, now),
    // tokens are flowing, so this is not idle; it is a rate that cannot be quoted yet
    warming: !fine && unitsPerHour > 0,
    moved,
    // The first point is the only estimate of how long a point takes, and it is worth using: the
    // second one lands after roughly the same wait. Before it there is nothing to extrapolate from,
    // and a countdown invented from no data is the thing this whole gauge exists to avoid.
    eta: !fine && moved >= 1 && since > 0 ? (since / moved) * (MIN_POINTS - moved) : null,
    spanMs: fine ? Math.min(now - (samples.current[0]?.at ?? now), WINDOW_MS) : slow.spanMs,
    samples: samples.current,
    pct: limit.percent,
    fine
  }
}
