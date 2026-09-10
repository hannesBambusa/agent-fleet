export interface Sample {
  at: number
  pct: number
}

export interface Burn {
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

// long enough to average out a burst, short enough to notice you have stopped working
const WINDOW_MS = 30 * 60 * 1000
const MIN_SPAN_MS = 90 * 1000
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
  if (den === 0 || spanMs < MIN_SPAN_MS) return { perHour: 0, spanMs }
  // a negative slope means the window reset under us, which says nothing about the rate
  return { perHour: Math.max(0, num / den), spanMs }
}

export function project(pct: number, perHour: number, resetsAt: string | null, now: number): Burn {
  const toReset = resetsAt ? Math.max(0, Date.parse(resetsAt) - now) : null
  const left = Math.max(0, 100 - pct)
  const toCap = perHour > 0.5 ? (left / perHour) * 3_600_000 : null
  const capsFirst = toCap !== null && toReset !== null && toCap < toReset
  return {
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
