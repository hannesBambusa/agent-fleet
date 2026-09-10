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
const { rateOf, project } = await import(`file://${out}`).then((m) => m.default ?? m)

const MIN = 60_000
const HOUR = 60 * MIN
// a steady climb of `perHour` points, sampled every 30s for `mins` minutes
const climb = (perHour, mins, from = 0) =>
  Array.from({ length: mins * 2 + 1 }, (_, i) => ({ at: i * 30_000, pct: from + (perHour * (i * 30_000)) / HOUR }))

test('a steady climb reports its own rate', () => {
  const { perHour } = rateOf(climb(12, 10))
  assert.ok(Math.abs(perHour - 12) < 0.01, `got ${perHour}`)
})

test('too few samples, or too short a span, reports nothing rather than a guess', () => {
  assert.equal(rateOf([]).perHour, 0)
  assert.equal(rateOf([{ at: 0, pct: 1 }, { at: 1000, pct: 2 }]).perHour, 0)
  // three samples but only a minute apart: not enough to extrapolate five hours from
  assert.equal(rateOf(climb(30, 1).slice(0, 3)).perHour, 0)
})

test('a burst at the end does not become the whole slope', () => {
  const steady = climb(6, 20)
  const withBurst = [...steady, { at: 20 * MIN + 30_000, pct: steady[steady.length - 1].pct + 4 }]
  const { perHour } = rateOf(withBurst)
  // first-to-last would read about 18%/h here; least squares keeps it near the real trend
  assert.ok(perHour > 6 && perHour < 12, `got ${perHour}`)
})

test('a window that reset under us never reports a negative rate', () => {
  const samples = [...climb(10, 10), { at: 11 * MIN, pct: 0 }]
  assert.ok(rateOf(samples).perHour >= 0)
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
