import { useEffect, useState } from 'react'
import type { PurgePlan, PurgeResult } from '../../../shared/types'
import { useOverlay } from '../state/overlay'

function size(n: number): string {
  return n < 1024 ? `${n}b` : n < 1024 * 1024 ? `${Math.round(n / 1024)}k` : `${(n / 1024 / 1024).toFixed(1)}M`
}

/**
 * Removing an agent, and meaning it.
 *
 * "Remove" used to mean the app forgetting its own record, so the conversation came straight back as
 * a terminal session and the worktree stayed on disk forever. This deletes what is actually there,
 * which is not reversible, so it counts everything first and says plainly what each part costs.
 *
 * Uncommitted files and commits on no remote are the only things here that cannot be got back, so
 * those are stated in red and the worktree box unticks itself when they exist. Everything else is a
 * transcript, which is a record of a conversation, not the work it produced.
 */
export function RemoveDialog({
  agentId,
  title,
  onClose,
  onDone
}: {
  agentId: string
  title: string
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const [plan, setPlan] = useState<PurgePlan | null>(null)
  const [worktree, setWorktree] = useState(false)
  const [branch, setBranch] = useState(false)
  const [transcript, setTranscript] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PurgeResult | null>(null)
  useOverlay(true)

  useEffect(() => {
    void window.api.agents.purgePlan(agentId).then((p) => {
      setPlan(p)
      // ticked by default only when there is nothing in it to lose
      const safe = !!p?.worktree && p.worktree.dirty === 0 && p.worktree.unpushed === 0
      setWorktree(safe)
      setBranch(safe)
    })
  }, [agentId])

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose, busy])

  const risky = !!plan?.worktree && worktree && (plan.worktree.dirty > 0 || plan.worktree.unpushed > 0)

  async function go(): Promise<void> {
    setBusy(true)
    try {
      setResult(await window.api.agents.purge(agentId, { worktree, branch, transcript }))
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-8" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-[520px] flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
      >
        <div className="flex items-baseline gap-2 border-b border-[var(--line)] px-4 py-3">
          <span className="text-[13px] font-semibold">remove</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--muted)]">{title}</span>
        </div>

        <div className="px-4 py-3">
          {!plan ? (
            <div className="text-[11px] text-[var(--dim)]">counting what is there…</div>
          ) : result ? (
            <div className="flex flex-col gap-1">
              {result.done.map((d) => (
                <div key={d} className="mono text-[11px] text-[var(--accent)]">
                  ✓ {d}
                </div>
              ))}
              {result.failed.map((f) => (
                <div key={f} className="mono text-[11px] text-[var(--danger)]">
                  ✕ {f}
                </div>
              ))}
              {!result.done.length && !result.failed.length && (
                <div className="text-[11px] text-[var(--dim)]">the agent is gone; nothing else was deleted</div>
              )}
            </div>
          ) : (
            <>
              <Row on label="the agent" note="its record here, and its terminal" fixed />

              <Row
                on={transcript}
                onToggle={() => setTranscript(!transcript)}
                label="the conversation"
                note={
                  plan.transcripts.length
                    ? `${plan.transcripts.length} transcript${plan.transcripts.length === 1 ? '' : 's'} · ${size(
                        plan.transcripts.reduce((n, t) => n + t.bytes, 0)
                      )} · without this the card comes back`
                    : 'nothing written yet'
                }
              />

              {plan.worktree ? (
                <>
                  <Row
                    on={worktree}
                    onToggle={() => setWorktree(!worktree)}
                    label={`the worktree ${plan.worktree.name}`}
                    note={plan.worktree.path}
                    danger={plan.worktree.dirty > 0 || plan.worktree.unpushed > 0}
                  />
                  {(plan.worktree.dirty > 0 || plan.worktree.unpushed > 0) && (
                    <div className="mb-2 ml-6 text-[11px] text-[var(--danger)]">
                      {plan.worktree.dirty > 0 && <div>{plan.worktree.dirty} uncommitted file(s), lost for good</div>}
                      {plan.worktree.unpushed > 0 && (
                        <div>{plan.worktree.unpushed} commit(s) on no remote, lost with the branch</div>
                      )}
                    </div>
                  )}
                  {plan.worktree.branch && (
                    <Row
                      on={branch}
                      onToggle={() => setBranch(!branch)}
                      label={`the branch ${plan.worktree.branch}`}
                      note={worktree ? 'deleted after the worktree' : 'needs the worktree removed first'}
                      danger={plan.worktree.unpushed > 0}
                    />
                  )}
                </>
              ) : (
                <Row on={false} label="no worktree" note="this agent worked in the repository itself" fixed />
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--line)] px-4 py-2.5">
          {risky && <span className="lbl !text-[var(--danger)]">this throws away work that exists nowhere else</span>}
          <button onClick={onClose} className="chip ml-auto hover:!text-[var(--fg)]">
            {result ? 'close' : 'cancel'}
          </button>
          {!result && (
            <button
              onClick={() => void go()}
              disabled={busy || !plan}
              className="rounded px-3 py-1 text-[11.5px] font-medium disabled:opacity-30"
              style={{ background: risky ? 'var(--danger)' : 'var(--accent)', color: 'var(--ink)' }}
            >
              {busy ? 'removing…' : risky ? 'delete anyway' : 'remove'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({
  on,
  onToggle,
  label,
  note,
  fixed,
  danger
}: {
  on: boolean
  onToggle?: () => void
  label: string
  note: string
  fixed?: boolean
  danger?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onToggle}
      disabled={!onToggle}
      className="mb-2 flex w-full items-start gap-2 text-left disabled:opacity-70"
    >
      <span
        className="mt-[2px] flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] border text-[9px]"
        style={
          on
            ? {
                background: danger ? 'var(--danger)' : 'var(--accent)',
                borderColor: danger ? 'var(--danger)' : 'var(--accent)',
                color: 'var(--ink)'
              }
            : { borderColor: 'var(--line)', color: 'transparent' }
        }
      >
        ✓
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px]">
          {label}
          {fixed && <span className="lbl ml-1.5">always</span>}
        </span>
        <span className="mono block truncate text-[10px] text-[var(--dim)]" title={note}>
          {note}
        </span>
      </span>
    </button>
  )
}
