// The burn rate behind the usage strip: how fast the 5h window is going, and what that means.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-burn-'))
const out = join(dir, 'burn.cjs')
await build({
  entryPoints: ['src/renderer/src/state/burnRate.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { rateOf, project, settle, stalled, scaleOf, averageRate, capped, shaped } = await import(`file://${out}`).then((m) => m.default ?? m)

const MIN = 60_000
const HOUR = 60 * MIN
// a steady climb of `perHour` points, sampled every 30s for `mins` minutes
const climb = (perHour, mins, from = 0) =>
  Array.from({ length: mins * 2 + 1 }, (_, i) => ({ at: i * 30_000, pct: from + (perHour * (i * 30_000)) / HOUR }))

// what the app actually receives: the same climb reported as whole percentage points
const stepped = (perHour, mins, from = 0) =>
  climb(perHour, mins, from).map((s) => ({ ...s, pct: Math.floor(s.pct) }))

test('a steady climb reports its own rate', () => {
  const { perHour } = rateOf(climb(12, 30))
  assert.ok(Math.abs(perHour - 12) < 0.5, `got ${perHour}`)
})

test('a whole-percent signal is read correctly once it has moved enough', () => {
  // the real feed: integers, so the rate can only be recovered over several steps
  const { perHour } = rateOf(stepped(12, 30))
  assert.ok(Math.abs(perHour - 12) < 2, `got ${perHour}`)
})

test('one step in a short window is not a rate', () => {
  // 24% to 25% two minutes apart would read as 30%/h, which is how a quiet session was told it
  // would burn out before the reset
  const jump = [
    { at: 0, pct: 24 },
    { at: 60_000, pct: 24 },
    { at: 120_000, pct: 25 }
  ]
  assert.equal(rateOf(jump).perHour, 0)
})

test('a long flat stretch reports nothing rather than a tiny rate', () => {
  const flat = Array.from({ length: 60 }, (_, i) => ({ at: i * 30_000, pct: 24 }))
  assert.equal(rateOf(flat).perHour, 0)
})

test('one step across half an hour is still not enough to extrapolate five hours from', () => {
  const slow = Array.from({ length: 60 }, (_, i) => ({ at: i * 30_000, pct: i < 30 ? 24 : 25 }))
  assert.equal(rateOf(slow).perHour, 0, 'one point of movement says too little')
})

test('too few samples, or too short a span, reports nothing rather than a guess', () => {
  assert.equal(rateOf([]).perHour, 0)
  assert.equal(rateOf([{ at: 0, pct: 1 }, { at: 1000, pct: 2 }]).perHour, 0)
  assert.equal(rateOf(climb(30, 1).slice(0, 3)).perHour, 0)
})

test('a burst at the end does not become the whole slope', () => {
  const steady = climb(6, 30)
  const withBurst = [...steady, { at: 30 * MIN + 30_000, pct: steady[steady.length - 1].pct + 4 }]
  const { perHour } = rateOf(withBurst)
  // first-to-last would read about 18%/h here; least squares keeps it near the real trend
  assert.ok(perHour > 6 && perHour < 12, `got ${perHour}`)
})

test('a window that reset under us never reports a negative rate', () => {
  const samples = [...climb(10, 30), { at: 31 * MIN, pct: 0 }]
  assert.ok(rateOf(samples).perHour >= 0)
})

test('an unmeasured rate projects nothing at all', () => {
  const b = project(50, 0, new Date(2 * HOUR).toISOString(), 0)
  assert.equal(b.measured, false)
  assert.equal(b.toCap, null)
  assert.equal(b.capsFirst, false)
})

test('the projection says when the limit runs out', () => {
  const b = project(50, 25, null, 0)
  assert.equal(b.toCap, 2 * HOUR, '50 points left at 25 an hour')
})

test('a rate too slow to matter projects nothing', () => {
  assert.equal(project(50, 0.2, null, 0).toCap, null)
})

test('capping before the reset is the case worth flagging', () => {
  const resets = new Date(3 * HOUR).toISOString()
  assert.equal(project(50, 25, resets, 0).capsFirst, true, 'caps in 2h, resets in 3h')
  assert.equal(project(50, 10, resets, 0).capsFirst, false, 'caps in 5h, resets in 3h')
})

test('a full window is already spent, not projected', () => {
  assert.equal(project(100, 25, null, 0).toCap, 0)
})

test('it says how long before the reset the cap lands', () => {
  const resets = new Date(3 * HOUR).toISOString()
  const b = project(50, 25, resets, 0)
  assert.equal(b.toCap, 2 * HOUR)
  assert.equal(b.earlyBy, HOUR, 'caps an hour before the window turns over')
})

test('when it is safe, it says what rate would not be', () => {
  const resets = new Date(2 * HOUR).toISOString()
  const b = project(40, 10, resets, 0)
  assert.equal(b.capsFirst, false)
  assert.equal(b.earlyBy, null)
  assert.equal(b.needRate, 30, '60 points left over two hours')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))

// A stopped fleet writes no status line, so the feed simply stops. The gauge has to fall on the
// clock rather than wait for a payload that is never coming.
test('silence since the last sample is measured as flat, not as the last rate', () => {
  const s = stepped(20, 20)
  const now = s[s.length - 1].at + 20 * MIN
  const live = settle(s, now, 45 * MIN)
  assert.equal(live[live.length - 1].at, now)
  assert.equal(live[live.length - 1].pct, s[s.length - 1].pct)
  assert.ok(rateOf(live).perHour < 20, 'a flat tail has to pull the rate down')
})

test('a fresh feed is left alone', () => {
  const s = stepped(20, 20)
  const now = s[s.length - 1].at + 30_000
  assert.equal(settle(s, now, 45 * MIN).length, s.length)
})

test('ten minutes without a step up counts as stopped', () => {
  const s = stepped(20, 20)
  const last = s[s.length - 1].at
  assert.equal(stalled(s, last + MIN), false)
  assert.equal(stalled(s, last + 11 * MIN), true)
})

test('a window that never moved is stopped, not slow', () => {
  const flat = Array.from({ length: 20 }, (_, i) => ({ at: i * 30_000, pct: 4 }))
  assert.equal(stalled(flat, 10 * MIN), true)
})

test('idling past the whole window still reads as flat, not as no data', () => {
  const s = stepped(20, 20)
  const now = s[s.length - 1].at + 2 * HOUR
  const live = settle(s, now, 20 * MIN)
  assert.equal(live.length, 2, 'the last known level is carried forward')
  assert.equal(live[0].pct, live[1].pct)
  assert.equal(rateOf(live).perHour, 0)
  assert.equal(stalled(live, now), true)
})

test('the scale is measured from the percentage the window reports', () => {
  // 10 points of the window over 100k units of spend
  const s = [
    { at: 0, pct: 20, units: 0 },
    { at: 10 * MIN, pct: 25, units: 50_000 },
    { at: 20 * MIN, pct: 30, units: 100_000 }
  ]
  assert.ok(Math.abs(scaleOf(s) - 10 / 100_000) < 1e-9)
})

test('one whole point of movement is a rounding error, not a ratio', () => {
  const s = [
    { at: 0, pct: 20, units: 0 },
    { at: 5 * MIN, pct: 21, units: 9_000 }
  ]
  assert.equal(scaleOf(s), null)
})

// The window's own average, which needs no calibration and cannot belong to a different window.
test('the average comes from the percentage and the reset time alone', () => {
  const now = Date.parse('2026-09-11T12:00:00Z')
  // resets in 4h, so the window opened an hour ago; 8% in that hour
  const r = averageRate(8, '2026-09-11T16:00:00Z', now)
  assert.ok(Math.abs(r.perHour - 8) < 0.01)
})

test('the first minutes of a window are not a rate', () => {
  const now = Date.parse('2026-09-11T12:00:00Z')
  // resets in 4h 55m: the window is five minutes old
  assert.equal(averageRate(1, '2026-09-11T16:55:00Z', now).perHour, 0)
})

test('no reset time, no average', () => {
  assert.equal(averageRate(50, null, Date.now()).perHour, 0)
})

// A ratio fitted to mismatched counters lands orders of magnitude out, and that number is the one
// the "you will run out" alarm is drawn from.
test('the token rate is capped against what the window has actually seen', () => {
  assert.equal(capped(260, 11.7), 11.7 * 4)
  assert.equal(capped(20, 11.7), 20, 'a real burst runs several times the average and is left alone')
})

test('with no average to check against, the token rate stands', () => {
  assert.equal(capped(30, 0), 30)
})

// An average cannot fall when the agents stop, and that is the one thing the gauge is watched for.
test('the average bends with how busy the fleet is now', () => {
  // spending half the tokens per hour this load has averaged reads as half the burn
  assert.equal(shaped(12, 500_000, 1_000_000), 6)
  assert.equal(shaped(12, 2_000_000, 1_000_000), 24)
})

test('a swing beyond four times its own typical is not trusted', () => {
  assert.equal(shaped(12, 90_000_000, 1_000_000), 48)
})

test('without a token history of its own, the plain average stands', () => {
  assert.equal(shaped(12, 3_000_000, 0), 12)
})

// A window reports whole percents, so two points three minutes apart is a rounding error with a
// short lever: it once read 700%/h and "full 4h 49m early" on a window three minutes old.
test('a ratio needs a long enough stretch, not just enough movement', () => {
  const quick = [
    { at: 0, pct: 1, units: 0 },
    { at: 3 * MIN, pct: 6, units: 900_000 }
  ]
  assert.equal(scaleOf(quick), null)
  const slow = [
    { at: 0, pct: 1, units: 0 },
    { at: 40 * MIN, pct: 6, units: 12_000_000 }
  ]
  assert.ok(scaleOf(slow) > 0)
})
