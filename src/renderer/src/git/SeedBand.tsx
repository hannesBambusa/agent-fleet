import { useCallback, useEffect, useState } from 'react'
import type { SeedItem, SeedPlan } from '../../../shared/types'

function size(n: number): string {
  if (!n) return ''
  return n < 1024 ? `${n}b` : n < 1024 * 1024 ? `${Math.round(n / 1024)}k` : `${(n / 1024 / 1024).toFixed(1)}M`
}

/**
 * A worktree only contains what git tracks, so everything ignored on purpose — `.env` first of all —
 * is missing, and the agent finds out by failing. Config is copied automatically at launch; this band
 * says what was carried, and offers the rest: a re-copy after the original changed, and the
 * dependency directories, which are linked rather than copied and are the user's call.
 */
export function SeedBand({ repoPath, cwd }: { repoPath: string; cwd: string }): JSX.Element | null {
  const [plan, setPlan] = useState<SeedPlan | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setPlan(await window.api.seedPlan(repoPath, cwd))
    } catch {
      setPlan(null)
    }
  }, [repoPath, cwd])

  useEffect(() => {
    setNote(null)
    void load()
  }, [load])

  if (!plan?.items.length) return null
  const missing = plan.items.filter((i) => !i.present)
  const carried = plan.items.filter((i) => i.present)

  async function carry(items: SeedItem[]): Promise<void> {
    setBusy(items.map((i) => i.path).join(','))
    try {
      const r = await window.api.seedApply(repoPath, cwd, items)
      setNote(
        r.failed.length
          ? `could not carry ${r.failed.join(', ')}`
          : `carried ${r.done.join(', ')}${items.some((i) => i.kind === 'link') ? ' (linked to the main checkout)' : ''}`
      )
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-b border-[var(--line)] px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="lbl">environment</span>
        <span className="text-[11px] text-[var(--dim)]">
          {carried.length ? `${carried.length} carried from the main checkout` : 'nothing carried yet'}
          {missing.length ? ` · ${missing.length} available` : ''}
        </span>
        {!!missing.filter((i) => i.kind === 'copy').length && (
          <button
            onClick={() => void carry(missing.filter((i) => i.kind === 'copy'))}
            disabled={!!busy}
            className="chip chip-running ml-auto shrink-0 hover:brightness-110 disabled:opacity-40"
            title="copy the ignored config this worktree is missing"
          >
            copy config
          </button>
        )}
        <button
          onClick={() => setOpen(!open)}
          className={`lbl shrink-0 hover:!text-[var(--accent)] ${missing.some((i) => i.kind === 'copy') ? '' : 'ml-auto'}`}
        >
          {open ? 'hide ▴' : 'details ▾'}
        </button>
      </div>

      {note && <div className="mono mt-1 text-[10px] text-[var(--accent)]">{note}</div>}

      {open && (
        <div className="mt-1.5 flex flex-col gap-px">
          {plan.items.map((i) => (
            <div key={i.path} className="flex items-center gap-2 rounded bg-[var(--raised)] px-2 py-1">
              <span className={`mono w-3 shrink-0 text-[11px] ${i.present ? 'text-[var(--accent)]' : 'text-[var(--dim)]'}`}>
                {i.present ? '✓' : '·'}
              </span>
              <span className="mono truncate text-[11px]">{i.path}</span>
              <span className="lbl shrink-0">{i.kind}</span>
              <span className="mono ml-auto shrink-0 text-[10px] text-[var(--dim)]">{size(i.size)}</span>
              {!i.present && (
                <button
                  onClick={() => void carry([i])}
                  disabled={!!busy}
                  className="chip chip-idle shrink-0 hover:brightness-110 disabled:opacity-40"
                  title={
                    i.kind === 'link'
                      ? `symlink ${i.path} to the one in the main checkout, rather than copying it`
                      : `copy ${i.path} into this worktree`
                  }
                >
                  {busy === i.path ? '…' : i.kind}
                </button>
              )}
            </div>
          ))}
          <div className="mt-1 text-[10.5px] text-[var(--dim)]">
            Copies are this worktree&apos;s own, so the agent cannot change the originals. Links point
            at the main checkout, which is what you want for dependencies and not for anything the
            agent might rewrite.
          </div>
        </div>
      )}
    </div>
  )
}
