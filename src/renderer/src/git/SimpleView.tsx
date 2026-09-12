import type { GitCommit, GitFile, GitStatus, MergePlan } from '../../../shared/types'
import { age } from '../lib/format'
import { Pipeline } from './Pipeline'
import { nextOf } from './flow'

const letterColor: Record<string, string> = {
  M: 'text-[#e0af68]',
  A: 'text-[#8bf0bd]',
  D: 'text-[#ff9b93]',
  R: 'text-[#7aa2f7]',
  C: 'text-[#7aa2f7]',
  U: 'text-[var(--danger)]',
  '?': 'text-[var(--muted)]'
}

/**
 * The guided view: where the work is, and the one thing to do about it.
 *
 * Everything here is a consequence of the station the work is sitting at, so only the detail that
 * belongs to that station is shown. The full pane is a tab away for when the question is "what
 * exactly changed" rather than "what do I do now".
 */
export function SimpleView({
  wt,
  host,
  plan,
  worktree,
  busy,
  message,
  onMessage,
  onStage,
  onCommit,
  onMerge,
  onMergeAside,
  onUpdate,
  onFile
}: {
  wt: GitStatus | null
  host: GitStatus | null
  plan: MergePlan | null
  worktree: boolean
  busy: string | null
  message: string
  onMessage: (v: string) => void
  onStage: () => void
  onCommit: () => void
  onMerge: () => void
  onMergeAside: () => void
  onUpdate: () => void
  /** opening a file hands the reader to the full view, which is where diffs live */
  onFile: (f: GitFile) => void
}): JSX.Element {
  const next = nextOf(wt, host, plan, worktree)
  const open = [...(wt?.unstaged ?? []), ...(wt?.staged ?? [])]
  // Commits this branch adds on top of main, which is the work that still has to travel. Not
  // "unpushed", which after an update from main also counts main's own commits coming the other way.
  const waiting: GitCommit[] = wt?.aheadCommits ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Pipeline
        wt={wt}
        host={host}
        plan={plan}
        worktree={worktree}
        busy={busy}
        onStage={onStage}
        onCommit={onCommit}
        onMerge={onMerge}
        onMergeAside={onMergeAside}
        onUpdate={onUpdate}
      />

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {next.action === 'commit' && (
          <div className="mb-4">
            <div className="lbl mb-1">commit message</div>
            <input
              value={message}
              onChange={(e) => onMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && message.trim()) onCommit()
              }}
              placeholder="what this change does"
              className="w-full rounded border border-[var(--line)] bg-[var(--ink)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]"
            />
          </div>
        )}

        {!!open.length && (
          <Section title={`open files · ${open.length}`}>
            {open.slice(0, 40).map((f) => (
              <button
                key={`${f.path}:${f.staged}`}
                onClick={() => onFile(f)}
                className="flex w-full items-baseline gap-2 rounded px-1 py-[3px] text-left hover:bg-[var(--raised)]"
              >
                <span className={`mono w-3 shrink-0 text-[10px] ${letterColor[f.letter] ?? ''}`}>{f.letter}</span>
                <span className="mono min-w-0 flex-1 truncate text-[11px]">{f.path}</span>
                <span className="lbl shrink-0 !text-[9px]">{f.staged ? 'staged' : 'changed'}</span>
              </button>
            ))}
            {open.length > 40 && <div className="mono px-1 text-[10px] text-[var(--dim)]">… {open.length - 40} more</div>}
          </Section>
        )}

        {!!waiting.length && (
          <Section title={`waiting to be merged into ${wt?.base ?? 'main'} · ${waiting.length}`}>
            {waiting.slice(0, 20).map((c) => (
              <div key={c.sha} className="flex items-baseline gap-2 px-1 py-[3px]">
                <span className="mono shrink-0 text-[10px] text-[var(--dim)]">{c.sha}</span>
                <span className="min-w-0 flex-1 truncate text-[11px]">{c.subject}</span>
                <span className="mono shrink-0 text-[9.5px] text-[var(--dim)]">{age(c.at)}</span>
              </div>
            ))}
          </Section>
        )}

        {!open.length && !waiting.length && (
          <div className="px-1 py-2 text-[11px] text-[var(--dim)]">
            nothing open in this worktree
            {next.done ? ' · everything here is merged and pushed' : ''}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-4">
      <div className="lbl mb-1">{title}</div>
      {children}
    </div>
  )
}
