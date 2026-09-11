export interface Sample {
  at: number
  pct: number
  /** the fleet's cumulative spend at that moment, in the units of `spend.ts` */
  units?: number
}

export interface Burn {
  /** enough span and movement to mean something; below this the app says nothing rather than guessing */
  measured: boolean
  /** percentage points of the window consumed per hour, at the rate of the last few minutes */
  perHour: number
  /** ms until the limit would be spent, or null when it is not moving */
  toCap: number | null
  /** ms until the window resets and the percentage goes back to zero */
  toReset: number | null
  /** the limit runs out before the window resets, which is the only bad case */
  capsFirst: boolean
  /** how long before the reset it would run out, when it does */
  earlyBy: number | null
  /** the rate that would exactly spend what is left by the time the window resets */
  needRate: number | null
  /** how much of a window the estimate is based on; a short one is a guess */
  spanMs: number
}

// Claude Code reports the window as a whole number of percent, so the signal arrives as steps, not
// as a curve. That sets the floor for what can honestly be measured: one step inside ninety seconds
// would imply 40%/h, which is how a quiet session with two agents got told it would burn out.
// Two steps and a few minutes is the least that carries information.
const MIN_SPAN_MS = 8 * 60 * 1000
const MIN_MOVE = 2
/** whole points of the window the ratio needs before it means anything */
export const MIN_POINTS = MIN_MOVE
const MIN_SAMPLES = 3

/**
 * How fast the five hour window is being spent, and what that means.
 *
 * A percentage says where you are, not where you are going: 60% is fine at the end of a session and
 * alarming ten minutes in. The rate is what tells you whether the work you are about to start will
 * finish, so the useful sentence is not "60% used" but "at this rate it runs out before it resets".
 *
 * Least squares over the recent samples rather than first-to-last, because a single burst at either
 * end of the window would otherwise set the whole slope.
 */
export function rateOf(samples: Sample[]): { perHour: number; spanMs: number } {
  if (samples.length < MIN_SAMPLES) return { perHour: 0, spanMs: 0 }
  const first = samples[0].at
  const xs = samples.map((s) => (s.at - first) / 3_600_000)
  const ys = samples.map((s) => s.pct)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  const spanMs = samples[n - 1].at - first
  const moved = ys[n - 1] - ys[0]
  // not enough time, or not enough movement, to say anything: a rate invented from one step is worse
  // than no rate, because it is believed
  if (den === 0 || spanMs < MIN_SPAN_MS || moved < MIN_MOVE) return { perHour: 0, spanMs }
  // a negative slope means the window reset under us, which says nothing about the rate
  return { perHour: Math.max(0, num / den), spanMs }
}

// A payload is only written while something is drawing a status line, so silence is itself the
// signal: no agent running means no fresh numbers, and a rate left frozen at whatever the last busy
// minutes measured reads as a burn that stopped happening. A gap counts as flat, not as missing.
const QUIET_MS = 90 * 1000
// Whole-percent steps mean a stall can only be bounded, not measured: ten minutes without one puts
// the rate under 6%/h, which is low enough against any plausible redline to call it stopped.
export const IDLE_MS = 10 * 60 * 1000

/** The samples inside the window, with the silence since the last one written in as flat. */
export function settle(samples: Sample[], now: number, windowMs: number): Sample[] {
  const live = samples.filter((s) => now - s.at <= windowMs)
  const newest = live[live.length - 1] ?? samples[samples.length - 1]
  if (!newest) return []
  // Sitting idle past the whole window would otherwise drop every sample and leave nothing to
  // measure, which reads as "no data" when it means the opposite: the last known level has simply
  // held. It is carried forward as the floor of the window so the answer stays "flat", not "unknown".
  if (!live.length) return [{ at: now - windowMs, pct: newest.pct }, { at: now, pct: newest.pct }]
  if (now - newest.at <= QUIET_MS) return live
  return [...live, { at: now, pct: newest.pct }]
}

/** Has the window stopped moving? The last step up is the only thing that dates a burn. */
export function stalled(samples: Sample[], now: number): boolean {
  if (samples.length < 2) return true
  for (let i = samples.length - 1; i > 0; i--) {
    if (samples[i].pct > samples[i - 1].pct) return now - samples[i].at > IDLE_MS
  }
  return true
}

export function project(pct: number, perHour: number, resetsAt: string | null, now: number): Burn {
  const toReset = resetsAt ? Math.max(0, Date.parse(resetsAt) - now) : null
  const left = Math.max(0, 100 - pct)
  const toCap = perHour > 0.5 ? (left / perHour) * 3_600_000 : null
  const capsFirst = toCap !== null && toReset !== null && toCap < toReset
  return {
    measured: perHour > 0,
    perHour,
    toCap,
    toReset,
    capsFirst,
    earlyBy: capsFirst && toReset !== null && toCap !== null ? toReset - toCap : null,
    // what it would take to run out exactly as the window turns over: the headroom, as a rate
    needRate: toReset && toReset > 0 ? left / (toReset / 3_600_000) : null,
    spanMs: 0
  }
}

/**
 * Percentage points per unit of spend, measured rather than assumed.
 *
 * The window's own percentage is the only authority on what a token costs against the limit, and it
 * is reported in whole numbers. Over a long enough span those steps add up to a usable ratio, and
 * that ratio is what turns the fine signal into the same currency the redline is quoted in.
 */
export function scaleOf(samples: Sample[]): number | null {
  const have = samples.filter((s) => s.units !== undefined)
  if (have.length < 2) return null
  const first = have[0]
  const last = have[have.length - 1]
  const dp = last.pct - first.pct
  const du = (last.units ?? 0) - (first.units ?? 0)
  // two whole points is the least that carries a ratio rather than a rounding error
  if (dp < MIN_MOVE || du <= 0) return null
  return dp / du
}
