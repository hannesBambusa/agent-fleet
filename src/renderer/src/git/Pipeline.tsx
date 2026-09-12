import type { GitStatus, MergePlan } from '../../../shared/types'
import { hostNotes, incomingOf, nextOf, stagesOf, type Stage } from './flow'

/** Which checkout a station lives in, named by the branch actually sitting there. */
function whereOf(s: Stage, wt: GitStatus | null, host: GitStatus | null, plan: MergePlan | null): string {
  if (s.where === 'worktree') return wt?.branch ?? 'this agent'
  if (s.where === 'main') return plan?.into ?? host?.branch ?? 'main checkout'
  return host?.upstream ?? wt?.upstream ?? 'origin'
}

/**
 * Where the work has got to, both sides of the worktree at once.
 *
 * The thing a worktree makes hard is knowing which of five places your work is sitting in, and the
 * old pane could only show one checkout at a time, so the main one was permanently out of sight.
 * Here the stations are always drawn, the ones holding work are lit, and the rightmost lit station
 * is the answer. One action underneath, which is whatever the leftmost lit station needs.
 */
export function Pipeline({
  wt,
  host,
  plan,
  worktree,
  busy,
  onStage,
  onCommit,
  onMerge,
  onMergeAside,
  onUpdate
}: {
  wt: GitStatus | null
  host: GitStatus | null
  plan: MergePlan | null
  /** without one there is no main checkout to land in, so that station has nothing to say */
  worktree: boolean
  busy: string | null
  onStage: () => void
  onCommit: () => void
  onMerge: () => void
  /** merge with the base checkout's own uncommitted work stashed and restored */
  onMergeAside: () => void
  onUpdate: () => void
}): JSX.Element {
  const stages = stagesOf(wt, host, plan, worktree)
  const next = nextOf(wt, host, plan, worktree)
  const notes = hostNotes(host, plan)
  const incoming = incomingOf(wt)
  const run = { stage: onStage, commit: onCommit, merge: onMerge, mergeAside: onMergeAside }

  return (
    <div className="shrink-0 border-b border-[var(--line)] px-4 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="lbl">where this work is</span>
        <span className="mono text-[9px] text-[var(--dim)]">
          {worktree ? 'all local · pushing to the remote is done from the main checkout' : 'everything left of ‹on origin› is on this machine only'}
        </span>
      </div>
      <div className="flex items-stretch gap-0">
        {stages.map((s, i) => (
          <div key={s.key} className="flex min-w-0 flex-1 items-stretch">
            {i > 0 && (
              <span
                className="mx-1 self-center text-[11px]"
                style={{ color: stages[i - 1].state === 'holding' ? 'var(--accent)' : 'var(--line)' }}
                aria-hidden
              >
                ▸
              </span>
            )}
            <Station s={s} where={whereOf(s, wt, host, plan)} />
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="lbl shrink-0">next</span>
        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: next.done ? 'var(--muted)' : 'var(--fg)' }}>
          {next.text}
          {next.blocked && <span className="text-[var(--warn)]"> · {next.blocked}</span>}
        </span>
        {next.action && (
          <button
            onClick={run[next.action]}
            disabled={!!busy}
            className="chip chip-running shrink-0 hover:brightness-110 disabled:opacity-40"
          >
            {busy ?? next.button}
          </button>
        )}
      </div>

      {/* The only traffic that runs the other way. A branch cut days ago is merging into code it has
          never seen, and that is where the conflicts come from. */}
      {incoming && (
        <div className="mt-2 flex items-center gap-2">
          <span className="lbl shrink-0 !text-[var(--warn)]">incoming</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]">
            {incoming.text}
            {incoming.blocked && <span className="text-[var(--warn)]"> · {incoming.blocked}</span>}
          </span>
          <button
            onClick={onUpdate}
            disabled={!!busy || !!incoming.blocked}
            title={`merge ${incoming.base} into this worktree's branch, so the eventual merge back is against code that already agrees`}
            className="chip shrink-0 hover:brightness-110 disabled:opacity-40"
          >
            update from {incoming.base}
          </button>
        </div>
      )}

      {/* what the merge would land in the middle of; the worktree cannot see any of this */}
      {!!notes.length && (
        <div className="mono mt-1 truncate text-[10px] text-[var(--dim)]" title={notes.join(' · ')}>
          main checkout: {notes.join(' · ')}
        </div>
      )}
    </div>
  )
}

function Station({ s, where }: { s: Stage; where: string }): JSX.Element {
  const lit = s.state !== 'clear'
  const color = s.state === 'blocked' ? 'var(--warn)' : lit ? 'var(--accent)' : 'var(--dim)'
  return (
    <div
      className="flex min-w-0 flex-1 flex-col justify-center rounded px-2 py-2"
      style={{
        background: lit ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
        boxShadow: lit ? `inset 0 0 0 1px color-mix(in srgb, ${color} 35%, transparent)` : 'inset 0 0 0 1px var(--line)'
      }}
      title={`${s.count} ${s.unit}${s.count === 1 ? '' : 's'} ${s.label} · ${where}`}
    >
      <span className="mono text-[19px] leading-none" style={{ color }}>
        {s.state === 'clear' ? '—' : s.count}
      </span>
      <span className="lbl mt-1.5 truncate !text-[9px]" style={{ color: lit ? 'var(--fg)' : 'var(--muted)' }}>
        {s.label}
      </span>
      {/* the branch actually holding it, because "in main" means nothing without knowing which main */}
      <span className="mono mt-0.5 truncate text-[9px] text-[var(--dim)]">{where}</span>
    </div>
  )
}
