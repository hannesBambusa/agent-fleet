// The fleet's spend, counted from the token totals the tailer keeps per session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-fleet-spend-'))
const out = join(dir, 'spend.cjs')
await build({
  entryPoints: ['src/renderer/src/state/spend.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { units, advance, decay } = await import(`file://${out}`).then((m) => m.default ?? m)

const t = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })

test('output weighs more than input, and a cache read close to nothing', () => {
  assert.ok(units(t(0, 1000)) > units(t(1000, 0)))
  assert.ok(units(t(0, 0, 1000)) < units(t(1000, 0)))
})

test('only growth counts', () => {
  const a = advance({}, [{ id: 'x', tokens: t(100, 100) }])
  const b = advance(a.seen, [{ id: 'x', tokens: t(200, 100) }])
  assert.equal(b.delta, 100)
})

// A transcript scrolling into view for the first time carries its whole history, and counting that
// as spend in the last second is what puts the needle through the stop.
test('a session seen for the first time contributes nothing', () => {
  const { delta, seen } = advance({}, [{ id: 'old', tokens: t(500_000, 200_000) }])
  assert.equal(delta, 0)
  assert.ok(seen.old > 0)
})

test('a rewritten transcript re-baselines instead of going negative', () => {
  const a = advance({}, [{ id: 'x', tokens: t(1000, 1000) }])
  const b = advance(a.seen, [{ id: 'x', tokens: t(10, 10) }])
  assert.equal(b.delta, 0)
  const c = advance(b.seen, [{ id: 'x', tokens: t(20, 10) }])
  assert.equal(c.delta, 10)
})

test('every session in the fleet adds up', () => {
  const a = advance({}, [
    { id: 'x', tokens: t(0, 0) },
    { id: 'y', tokens: t(0, 0) }
  ])
  const b = advance(a.seen, [
    { id: 'x', tokens: t(100, 0) },
    { id: 'y', tokens: t(300, 0) }
  ])
  assert.equal(b.delta, 400)
})

// Tokens arrive in lumps - one message, then nothing for half a minute - so the needle is a decaying
// average measured every second rather than a literal per-second reading.
test('a steady spend settles on its own rate', () => {
  let r = 0
  // 1000 units a second, ticked every second for ten minutes
  for (let i = 0; i < 600; i++) r = decay(r, 1000, 1000)
  assert.ok(Math.abs(r - 3_600_000) / 3_600_000 < 0.01)
})

test('one lump does not peg the needle', () => {
  let r = 0
  // 60k units in a single tick, which as a literal per-second rate would read 216M/h
  r = decay(r, 60_000, 1000)
  assert.ok(r < 4_000_000, `a single message must not read as a sustained rate, got ${r}`)
})

test('the same tokens read the same whether they land in one lump or spread out', () => {
  let lumpy = 0
  let smooth = 0
  for (let i = 0; i < 300; i++) {
    lumpy = decay(lumpy, i % 30 === 0 ? 30_000 : 0, 1000)
    smooth = decay(smooth, 1000, 1000)
  }
  assert.ok(Math.abs(lumpy - smooth) / smooth < 0.2)
})

test('it falls towards zero when the tokens stop', () => {
  let r = 0
  for (let i = 0; i < 600; i++) r = decay(r, 1000, 1000)
  const busy = r
  for (let i = 0; i < 150; i++) r = decay(r, 0, 1000)
  assert.ok(r < busy * 0.15, 'two and a half minutes of silence has to show')
})
