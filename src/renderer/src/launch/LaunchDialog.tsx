import { useEffect, useState } from 'react'
import type { LaunchRequest, Repo } from '../../../shared/types'
import { useRepos } from '../state/agents'
import { useOverlay } from '../state/overlay'

interface Props {
  open: boolean
  onClose: () => void
  onLaunch: (req: LaunchRequest) => void
}

function canWorktree(r: Repo): boolean {
  return r.trusted && r.hasCommits
}

export function LaunchDialog({ open, onClose, onLaunch }: Props): JSX.Element | null {
  const { repos, refresh } = useRepos()
  const [repo, setRepo] = useState<Repo | null>(null)
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [worktree, setWorktree] = useState(true)
  // whether the choice on screen is the user's or just the first repo in the list
  const [chose, setChose] = useState(false)
  const [browser, setBrowser] = useState(true)
  useOverlay(open)
  const [chat, setChat] = useState(() => localStorage.getItem('agent-fleet.chatDefault') !== 'off')
  const [detached, setDetached] = useState(() => localStorage.getItem('agent-fleet.detachedDefault') === 'on')

  useEffect(() => {
    if (open) void refresh()
  }, [open])
  useEffect(() => {
    // only until something is chosen: picking "no repo" must not be undone by this
    if (!chose && repos.length) pick(repos[0])
  }, [repos, chose])
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  function pick(r: Repo | null): void {
    setRepo(r)
    setChose(true)
    setWorktree(!!r && r.worktree && canWorktree(r))
    setBrowser(r ? r.browser : true)
  }

  async function addFolder(): Promise<void> {
    const r = await window.api.repos.pickRepo()
    if (r) {
      await refresh()
      pick(r)
    }
  }

  function submit(): void {
    localStorage.setItem('agent-fleet.chatDefault', chat ? 'on' : 'off')
    localStorage.setItem('agent-fleet.detachedDefault', detached ? 'on' : 'off')
    // next time this repo opens with the answer you gave last time
    if (repo && repo.worktree !== worktree) void window.api.repos.upsertRepo({ ...repo, worktree })
    // an empty path means "no repo": the app gives it a scratch folder of its own
    onLaunch({ repoPath: repo?.path ?? '', prompt: prompt.trim(), name: name.trim(), worktree, browser, chat, detached })
    setPrompt('')
    setName('')
  }

  if (!open) return null
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/50 p-10" onMouseDown={onClose}>
      <div
        className="flex max-h-full w-[min(760px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-[var(--line)] px-5 py-3 text-[13px] font-semibold">New agent</div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4 text-[12px]">
          <div>
            <div className="mb-1.5 text-[var(--muted)]">repo</div>
            {/* The repositories are one set of choices; working in none of them is a different kind of
                choice, so it sits apart. Beside them it read as a repository called "no repo". */}
            <div className="flex flex-wrap items-center gap-1.5">
              {repos.map((r) => (
                <button
                  key={r.path}
                  onClick={() => pick(r)}
                  className={`rounded px-2 py-1 font-mono ${
                    repo?.path === r.path
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'bg-[var(--raised)] text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  {r.name}
                </button>
              ))}
              <button onClick={() => void addFolder()} className="rounded px-2 py-1 text-[var(--muted)] hover:text-[var(--fg)]">
                + folder
              </button>
            </div>

            <div className="mt-2 flex items-center gap-2 border-t border-[var(--line)] pt-2">
              <button
                onClick={() => pick(null)}
                role="switch"
                aria-checked={repo === null}
                className="flex items-center gap-2 text-left"
              >
                <span
                  className="relative block h-[14px] w-[26px] shrink-0 rounded-full transition-colors"
                  style={{
                    background: repo === null ? 'var(--accent)' : 'var(--raised)',
                    boxShadow: repo === null ? 'none' : 'inset 0 0 0 1px var(--line)'
                  }}
                >
                  <span
                    className="absolute top-[2px] block h-[10px] w-[10px] rounded-full transition-all"
                    style={{
                      left: repo === null ? '14px' : '2px',
                      background: repo === null ? 'var(--ink)' : 'var(--muted)'
                    }}
                  />
                </span>
                <span className="text-[12px]" style={{ color: repo === null ? 'var(--fg)' : 'var(--muted)' }}>
                  no repository
                </span>
              </button>
              <span className="text-[11px] text-[var(--dim)]">for a question, a script, anything not tied to a repo</span>
            </div>
            {repo ? (
              <div className="mt-1.5 font-mono text-[10.5px] text-[var(--dim)]">{repo.path}</div>
            ) : (
              <div className="mt-1.5 font-mono text-[10.5px] text-[var(--dim)]">
                ~/.claude/agent-fleet/scratch/… · a folder of its own, no worktree, no git
              </div>
            )}
            {repo && !repo.trusted && (
              <div className="mt-1.5 text-[11px] text-[var(--warn)]">
                Claude Code has not been trusted in this folder yet. First launch runs without a worktree so you can accept the
                trust dialog; worktrees work from the next launch.
              </div>
            )}
            {repo && repo.trusted && !repo.hasCommits && (
              <div className="mt-1.5 text-[11px] text-[var(--warn)]">
                This repo has no commits, so git cannot create a worktree from it. Launching without one; commit once and
                worktrees work.
              </div>
            )}
          </div>
          {repo && (
            <div>
              {/* Its own row rather than a switch among four: it is the decision that changes how the
                  whole session works, and half the time the answer is "no, this is a small change". */}
              <div className="mb-1.5 text-[var(--muted)]">where it works</div>
              <div className="grid grid-cols-2 gap-1.5">
                <Where
                  on={worktree}
                  disabled={!canWorktree(repo)}
                  onClick={() => canWorktree(repo) && setWorktree(true)}
                  label="its own worktree"
                  note={
                    canWorktree(repo)
                      ? 'a checkout and branch of its own · merge back when done'
                      : 'not possible here yet'
                  }
                />
                <Where
                  on={!worktree}
                  onClick={() => setWorktree(false)}
                  label={`${repo.name} itself`}
                  note="edits the checkout directly · no branch, no merge"
                />
              </div>
            </div>
          )}
          <div>
            <div className="mb-1.5 text-[var(--muted)]">prompt</div>
            <textarea
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // enter launches; shift/ctrl/alt+enter insert a newline
                if (e.key !== 'Enter') return
                if (e.shiftKey || e.ctrlKey || e.altKey) return
                e.preventDefault()
                submit()
              }}
              rows={7}
              placeholder="what should it do? leave empty for an interactive session"
              className="select w-full resize-none rounded border border-[var(--line)] bg-[var(--ink)] px-3 py-2 outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <div className="mb-1.5 text-[var(--muted)]">name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="left empty, Claude Code names the session from the work"
              className="select w-full rounded border border-[var(--line)] bg-[var(--ink)] px-2.5 py-1.5 font-mono outline-none focus:border-[var(--accent)]"
            />
          </div>

          {/* Two columns of rows rather than one line of switches: at four options the labels wrapped
              mid-phrase, and none of them said what they actually do. */}
          <div className="grid grid-cols-2 gap-x-5 gap-y-1">
            <Toggle on={browser} set={setBrowser} label="browser" note="a Chromium pane it can drive" />
            <Toggle on={chat} set={setChat} label="chat view" note="instead of the raw terminal" />
            <Toggle
              on={detached}
              set={setDetached}
              label="keep running"
              note="survives closing the app, in tmux"
            />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3">
          <span className="text-[11px] text-[var(--dim)]">↩ launch · ⇧↩ newline · esc close</span>
          <button
            onClick={submit}
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink)] disabled:opacity-40"
          >
            Launch
          </button>
        </div>
      </div>
    </div>
  )
}

/** One option: a switch, what it is, and one line on what it does. */
function Toggle({
  on,
  set,
  label,
  note,
  disabled
}: {
  on: boolean
  set: (v: boolean) => void
  label: string
  note: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      onClick={() => !disabled && set(!on)}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className="flex items-start gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--hover)] disabled:opacity-45 disabled:hover:bg-transparent"
    >
      <span
        className="relative mt-[2px] block h-[14px] w-[26px] shrink-0 rounded-full transition-colors"
        style={{
          background: on ? 'var(--accent)' : 'var(--raised)',
          boxShadow: on ? 'none' : 'inset 0 0 0 1px var(--line)'
        }}
      >
        <span
          className="absolute top-[2px] block h-[10px] w-[10px] rounded-full transition-all"
          style={{ left: on ? '14px' : '2px', background: on ? 'var(--ink)' : 'var(--muted)' }}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[12px] leading-tight" style={{ color: on ? 'var(--fg)' : 'var(--muted)' }}>
          {label}
        </span>
        <span className="mono block text-[10px] leading-snug text-[var(--dim)]">{note}</span>
      </span>
    </button>
  )
}

/** One side of the where-it-works choice: a card rather than a switch, because it is a fork. */
function Where({
  on,
  onClick,
  label,
  note,
  disabled
}: {
  on: boolean
  onClick: () => void
  label: string
  note: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded border px-2.5 py-2 text-left transition-colors disabled:opacity-40"
      style={{
        borderColor: on ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : 'var(--line)',
        background: on ? 'var(--accent-soft)' : 'transparent'
      }}
    >
      <span className="block text-[12px]" style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}>
        {label}
      </span>
      <span className="mono mt-0.5 block text-[10px] leading-snug text-[var(--dim)]">{note}</span>
    </button>
  )
}
