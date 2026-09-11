import type { TokenUsage } from '../../../shared/types'

// Rate limits are not charged per raw token: output is the expensive half and a cache read is close
// to free. These weights are a shape, not a price list. What they produce is a number that moves in
// proportion to the real spend; the factor that turns it into percentage points is measured against
// the window's own figure rather than assumed, so only the ratios have to be roughly right.
const IN = 1
const OUT = 5
const WRITE = 1.25
const READ = 0.1

/** One session's spend so far, in arbitrary units that track cost rather than token count. */
export function units(t: TokenUsage): number {
  return t.input * IN + t.output * OUT + t.cacheWrite * WRITE + t.cacheRead * READ
}

export interface Seen {
  [id: string]: number
}

/**
 * How much the fleet has spent since the last look.
 *
 * Only growth counts, and only for sessions already seen. A transcript the app has just discovered
 * arrives with its whole history attached, and counting that as spend in the last second would put
 * the needle through the stop every time an old session scrolls into view.
 */
export function advance(seen: Seen, sessions: Array<{ id: string; tokens: TokenUsage }>): { seen: Seen; delta: number } {
  const next: Seen = {}
  let delta = 0
  for (const s of sessions) {
    const total = units(s.tokens)
    const before = seen[s.id]
    // a total that went backwards means the transcript was rewritten, so re-baseline rather than
    // record a negative
    if (before !== undefined && total > before) delta += total - before
    next[s.id] = total
  }
  return { seen: next, delta }
}

// How quickly the needle forgets. Tokens do not arrive per second: one assistant message lands tens
// of thousands at once and then nothing for half a minute, so a literal per-second rate alternates
// between the stop and zero. A decaying average is measured every second and answers the same
// question - how fast right now - without inventing a spike out of message timing.
export const TAU_MS = 60 * 1000
// Nothing written for this long and the needle goes to zero outright rather than trailing off.
export const QUIET_MS = 60 * 1000

/**
 * The spend rate, decayed towards whatever the last moment actually spent.
 *
 * Each tick contributes its own tokens-per-hour, weighted by how much of the decay constant has
 * passed: a quiet second pulls the average down exactly as much as a busy one pushes it up, so the
 * needle falls on its own the moment the agents stop.
 */
export function decay(prev: number, delta: number, dtMs: number, tauMs = TAU_MS): number {
  if (dtMs <= 0) return prev
  const instant = (delta / dtMs) * 3_600_000
  const w = 1 - Math.exp(-dtMs / tauMs)
  return prev + (instant - prev) * w
}
