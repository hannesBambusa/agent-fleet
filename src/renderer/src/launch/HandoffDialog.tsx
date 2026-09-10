import { useEffect, useMemo, useState } from 'react'
import type { FileContents, LaunchRequest, Repo } from '../../../shared/types'
import { handoffAt, handoffPrompt, INLINE_LIMIT } from '../state/handoff'
import { useOverlay } from '../state/overlay'

/**
 * Hand a file to an agent somewhere else.
 *
 * One agent writes up what it found and the work belongs in another repository. Everything needed to
 * start that work is already known — the file, where it came from, what you want done — so this asks
 * for the two things it cannot know (which repo, and what to do) and starts the agent itself.
 *
 * The file is always copied into the new agent's own directory, so it can be re-read and so it is
 * thrown away with the worktree. A short one is pasted into the opening prompt as well, because an
 * agent that already has the context can begin; a long one is only pointed at, since pasting a novel
 * into the first prompt spends the context window before any work happens.
 */
export function HandoffDialog({
  path,
  fromRepo,
  onClose,
  onLaunch
}: {
  path: string
  fromRepo: string
  onClose: () => void
  onLaunch: (req: LaunchRequest) => void
}): JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([])
  const [target, setTarget] = useState<Repo | null>(null)
  const [note, setNote] = useState('')
  const [file, setFile] = useState<FileContents | null>(null)
  const [worktree, setWorktree] = useState(true)
  const [chat, setChat] = useState(true)
  const [preview, setPreview] = useState(false)
  useOverlay(true)

  useEffect(() => {
    void window.api.repos.listRepos().then((list) => {
      setRepos(list)
      // anywhere but here: a handoff to the repo it came from is a note to self
      setTarget(list.find((r) => r.name !== fromRepo) ?? list[0] ?? null)
    })
    void window.api.files.readFile(path).then(setFile)
  }, [path, fromRepo])

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const name = path.split('/').pop() ?? path
  const prompt = useMemo(
    () => (file ? handoffPrompt(note, { path, text: file.text }, fromRepo) : ''),
    [file, note, path, fromRepo]
  )
  const inlined = !!file && file.text.length <= INLINE_LIMIT
  const ready = !!target && !!file && !file.binary && !file.error

  function go(): void {
    if (!target || !file) return
    onLaunch({
      repoPath: target.path,
      prompt,
      // left empty on purpose: Claude Code titles the session from the work itself
      name: '',
      worktree: worktree && target.worktree !== false,
      browser: target.browser !== false,
      chat,
      detached: false,
      // always copied, whether or not the text is also in the prompt: the agent may want it again,
      // and it is thrown away with the worktree
      handoff: path
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-8" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-full w-[560px] flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
      >
        <div className="flex items-baseline gap-2 border-b border-[var(--line)] px-4 py-3">
          <span className="text-[13px] font-semibold">hand off</span>
          <span className="mono min-w-0 flex-1 truncate text-[11px] text-[var(--accent)]" title={path}>
            {name}
          </span>
          <span className="lbl shrink-0">from {fromRepo}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <div className="lbl mb-1.5">to which repo</div>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {repos.map((r) => (
              <button
                key={r.path}
                onClick={() => setTarget(r)}
                title={r.path}
                className={`chip ${target?.path === r.path ? 'chip-running' : 'chip-idle'} hover:brightness-110`}
              >
                {r.name}
              </button>
            ))}
            {!repos.length && <span className="text-[11px] text-[var(--dim)]">no repositories known yet</span>}
          </div>

          <div className="lbl mb-1.5">what should it do</div>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. implement the retur tables described here, then run the migrations"
            className="w-full resize-none rounded border border-[var(--line)] bg-[var(--ink)] px-2.5 py-2 text-[12px] outline-none focus:border-[var(--accent)]"
          />

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Toggle on={worktree} onClick={() => setWorktree(!worktree)}>
              own worktree
            </Toggle>
            <Toggle on={chat} onClick={() => setChat(!chat)}>
              open in chat
            </Toggle>
            <button onClick={() => setPreview(!preview)} className="lbl ml-auto hover:!text-[var(--accent)]">
              {preview ? 'hide the prompt' : 'see the prompt'}
            </button>
          </div>

          <div className="mono mt-2 text-[10px] text-[var(--dim)]">
            {!file
              ? 'reading the file…'
              : file.error
                ? file.error
                : file.binary
                  ? 'this file is not text, so there is nothing to hand over'
                  : inlined
                    ? `${file.text.length} characters, pasted into the opening prompt and copied to ${handoffAt(path)}`
                    : `${Math.round(file.text.length / 1000)}k characters, too long to paste: copied to ${handoffAt(path)} and read from there`}
          </div>

          {preview && (
            <pre className="select mono mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap rounded border border-[var(--line)] bg-[var(--ink)] px-2.5 py-2 text-[10px] leading-snug text-[var(--muted)]">
              {prompt}
            </pre>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--line)] px-4 py-2.5">
          <span className="lbl">
            {target ? `starts a new agent in ${target.name}` : 'pick a repo'}
          </span>
          <button onClick={onClose} className="chip ml-auto hover:!text-[var(--fg)]">
            cancel
          </button>
          <button
            onClick={go}
            disabled={!ready}
            className="rounded bg-[var(--accent)] px-3 py-1 text-[11.5px] font-medium text-[var(--ink)] disabled:opacity-30"
          >
            hand off
          </button>
        </div>
      </div>
    </div>
  )
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} className="flex items-center gap-1.5">
      <span
        className="flex h-[11px] w-[11px] items-center justify-center rounded-[3px] border text-[8px]"
        style={
          on
            ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--ink)' }
            : { borderColor: 'var(--line)', color: 'transparent' }
        }
      >
        ✓
      </span>
      <span className="lbl">{children}</span>
    </button>
  )
}
