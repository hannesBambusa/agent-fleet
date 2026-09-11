import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus, MergePlan, ShipEvent, ShipPlan, ShipResult, ShipStep } from '../../../shared/types'
import { Pipeline } from './Pipeline'

/**
 * The one path from "the agent is done" to "origin has it".
 *
 * It exists because doing this by hand is five commands across two checkouts, and the failure modes
 * are silent: a stale base, someone else's uncommitted files, a conflict found halfway through. The
 * same list is the plan before you press and the timeline while it runs, so what you were promised
 * and what happened are read in one place, in order.
 */

type Live = { done: boolean; ok?: boolean; text?: string; ms?: number }

const PLAN_STEP: ShipStep = {
  key: 'plan',
  title: 'check the repository',
  detail: 'fetch origin and re-read both checkouts',
  state: 'run'
}

interface Props {
  cwd: string
  onDone: () => void
  /** the agent's own tree, the checkout it merges into, and the merge itself: the three the band draws */
  wt: GitStatus | null
  host: GitStatus | null
  plan: MergePlan | null
  worktree: boolean
  busy: string | null
  onStage: () => void
  onCommit: () => void
  onMerge: () => void
  onUpdate: () => void
}

export function ShipPane({ cwd, onDone, wt, host, plan: merge, worktree, busy, onStage, onCommit, onMerge, onUpdate }: Props): JSX.Element {
  const [plan, setPlan] = useState<ShipPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<Record<string, Live>>({})
  const [result, setResult] = useState<ShipResult | null>(null)
  const tail = useRef<HTMLDivElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setPlan(await window.api.git.shipPlan(cwd))
    } catch {
      setPlan(null)
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    setResult(null)
    setConfirm(false)
    setLive({})
    void load()
  }, [load])

  // steps arrive one at a time while ship runs, so the timeline fills in rather than appearing at the end
  useEffect(() => {
    return window.api.git.onShipEvent((e: ShipEvent) => {
      setLive((prev) => ({ ...prev, [e.key]: { done: e.done, ok: e.ok, text: e.text, ms: e.ms } }))
      requestAnimationFrame(() => tail.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    })
  }, [])

  async function ship(): Promise<void> {
    if (!confirm) {
      setConfirm(true)
      return
    }
    setConfirm(false)
    setRunning(true)
    setResult(null)
    setLive({})
    try {
      setResult(await window.api.git.ship(cwd, message))
    } catch (err) {
      setResult({
        ok: false,
        deploy: null,
        sha: null,
        url: null,
        log: [{ key: 'error', title: 'ship', ok: false, text: err instanceof Error ? err.message : String(err), ms: 0 }]
      })
    } finally {
      setRunning(false)
      setMessage('')
      await load()
      onDone()
    }
  }

  const band = (
    <Pipeline
      wt={wt}
      host={host}
      plan={merge}
      worktree={worktree}
      busy={busy}
      onStage={onStage}
      onCommit={onCommit}
      onMerge={onMerge}
      onUpdate={onUpdate}
    />
  )

  if (loading && !plan) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {band}
        <div className="flex flex-1 items-center justify-center text-[11px] text-[var(--dim)]">reading the repository…</div>
      </div>
    )
  }
  if (!plan) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {band}
        <div className="flex flex-1 items-center justify-center text-[11px] text-[var(--dim)]">nothing to ship from here</div>
      </div>
    )
  }

  const needsMessage = plan.dirty.length > 0
  const ready = plan.ok && (!needsMessage || message.trim().length > 0)
  const started = running || result !== null
  // once it is running the plan step leads, because it is the first thing that actually happens
  const steps = started ? [PLAN_STEP, ...plan.steps.filter((s) => s.key !== 'plan')] : plan.steps
  const rows = [...steps]
  // the stash comes back after the push, so this row belongs at the end rather than beside its pair
  if (live.restore && !rows.some((r) => r.key === 'restore')) {
    rows.push({ key: 'restore', title: 'restore local changes', detail: 'put your files back', state: 'run' })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {band}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="mono text-[12px] text-[var(--accent)]">{plan.branch}</span>
          <span className="text-[11px] text-[var(--dim)]">→</span>
          <span className="mono text-[12px]">{plan.into}</span>
          <span className="mono ml-auto text-[10px] text-[var(--dim)]">
            {plan.commits} commit(s) · {plan.files} file(s)
          </span>
        </div>

        <ol className="relative">
          {rows.map((s, i) => (
            <Row key={s.key} n={i + 1} s={s} live={live[s.key]} last={i === rows.length - 1} />
          ))}
        </ol>
        <div ref={tail} />

        {needsMessage && !started && (
          <div className="mt-3">
            <div className="lbl mb-1">commit message · {plan.dirty.length} uncommitted file(s) in the worktree</div>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="what this change does"
              className="w-full rounded border border-[var(--line)] bg-[var(--ink)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]"
            />
            <div className="mono mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[10px] text-[var(--dim)]">
              {plan.dirty.slice(0, 12).join('\n')}
              {plan.dirty.length > 12 ? `\n… ${plan.dirty.length - 12} more` : ''}
            </div>
          </div>
        )}

        {!!plan.conflicts.length && !started && (
          <div className="mt-3 rounded border border-[var(--danger)] px-3 py-2">
            <div className="lbl mb-1 !text-[var(--danger)]">these files collide</div>
            <div className="mono whitespace-pre-wrap text-[10.5px] text-[var(--muted)]">{plan.conflicts.join('\n')}</div>
            <div className="mt-1.5 text-[11px] text-[var(--dim)]">
              Ask the agent to rebase onto {plan.into} and resolve them, then press recheck.
            </div>
          </div>
        )}

        {result && (
          <div className={`mt-3 rounded border px-3 py-2 ${result.ok ? 'border-[var(--accent)]' : 'border-[var(--danger)]'}`}>
            <div className={`lbl mb-1 ${result.ok ? '!text-[var(--accent)]' : '!text-[var(--danger)]'}`}>
              {result.ok ? 'shipped' : 'stopped'}
            </div>
            {result.ok ? (
              <div className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
                <div>
                  origin/{plan.into} is now {result.sha}.{' '}
                  {result.url && (
                    <button onClick={() => void window.api.shell.openExternal(result.url!)} className="text-[var(--accent)] hover:underline">
                      view the commit on GitHub ↗
                    </button>
                  )}
                </div>
                {result.deploy && (
                  <div>
                    {result.deploy.detail}.{' '}
                    <button
                      onClick={() => void window.api.shell.openExternal(result.deploy!.url)}
                      className="text-[var(--accent)] hover:underline"
                    >
                      {result.deploy.name} ↗
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-[var(--muted)]">
                {result.log.find((l) => !l.ok)?.text ?? 'nothing was left half-applied; your files are back where they were'}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--line)] px-3 py-2">
        <button onClick={() => void load()} disabled={running} className="chip chip-idle shrink-0 hover:brightness-110 disabled:opacity-40">
          recheck
        </button>
        <span className="text-[11px] text-[var(--dim)]">
          {running
            ? 'working through the steps…'
            : plan.ok
              ? needsMessage && !message.trim()
                ? 'a commit message is needed first'
                : `commits, merges and pushes ${plan.into} in one go`
              : (plan.steps.find((s) => s.state === 'block')?.detail ?? 'blocked')}
        </span>
        <button
          onClick={() => void ship()}
          disabled={!ready || running}
          className={`chip ml-auto shrink-0 ${confirm ? 'chip-waiting' : 'chip-running'} hover:brightness-110 disabled:opacity-40`}
        >
          {running ? 'shipping…' : confirm ? `confirm · push ${plan.into}` : `ship → origin/${plan.into}`}
        </button>
      </div>
    </div>
  )
}

const MARK: Record<ShipStep['state'], { sign: string; tone: string }> = {
  run: { sign: '', tone: 'border-[var(--line)]' },
  skip: { sign: '–', tone: 'border-[var(--line)]' },
  warn: { sign: '!', tone: 'border-[var(--warn)] text-[var(--warn)]' },
  block: { sign: '✕', tone: 'border-[var(--danger)] text-[var(--danger)]' }
}

function ticks(ms?: number): string {
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** One node on the rail: what it will do, what it is doing, or what it did. */
function Row({ n, s, live, last }: { n: number; s: ShipStep; live?: Live; last: boolean }): JSX.Element {
  const active = live && !live.done
  const done = live?.done === true
  const failed = done && live?.ok === false
  const passed = done && live?.ok !== false
  const m = MARK[s.state]

  const node = failed
    ? 'border-[var(--danger)] bg-[var(--danger)] text-[var(--ink)]'
    : passed
      ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--ink)]'
      : active
        ? 'border-[var(--accent)] text-[var(--accent)] node-breathe'
        : `bg-[var(--panel)] text-[var(--dim)] ${m.tone}`

  return (
    <li className={`relative flex gap-3 pb-1 ${active ? 'rail-live' : ''}`}>
      {/* the rail itself: a line between the nodes, stopping at the last one */}
      {!last && <span className="absolute left-[10px] top-[22px] bottom-0 w-px bg-[var(--line)]" aria-hidden />}
      <span
        className={`relative z-10 mt-1.5 flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-full border text-[10px] ${node}`}
      >
        {failed ? '✕' : passed ? '✓' : active ? '' : m.sign || n}
        {active && <span className="absolute inset-0 rounded-full border border-[var(--accent)] ring-pulse" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col py-1.5">
        <span className="flex items-baseline gap-2">
          <span className={`text-[11.5px] ${s.state === 'skip' && !live ? 'text-[var(--muted)]' : ''}`}>{s.title}</span>
          {done && <span className="mono ml-auto shrink-0 text-[10px] text-[var(--dim)]">{ticks(live?.ms)}</span>}
          {active && <span className="mono ml-auto shrink-0 text-[10px] text-[var(--accent)]">running</span>}
        </span>
        <span
          className={`mono truncate text-[10px] ${failed ? 'text-[var(--danger)]' : 'text-[var(--dim)]'}`}
          title={live?.text ?? s.detail}
        >
          {live?.text ?? s.detail}
        </span>
      </span>
    </li>
  )
}
