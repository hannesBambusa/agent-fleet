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
  const [browser, setBrowser] = useState(true)
  useOverlay(open)
  const [chat, setChat] = useState(() => localStorage.getItem('agent-fleet.chatDefault') !== 'off')
  const [detached, setDetached] = useState(() => localStorage.getItem('agent-fleet.detachedDefault') === 'on')

  useEffect(() => {
    if (open) void refresh()
  }, [open])
  useEffect(() => {
    if (!repo && repos.length) pick(repos[0])
  }, [repos])
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  function pick(r: Repo): void {
    setRepo(r)
    setWorktree(r.worktree && canWorktree(r))
    setBrowser(r.browser)
  }

  async function addFolder(): Promise<void> {
    const r = await window.api.pickRepo()
    if (r) {
      await refresh()
      pick(r)
    }
  }

  function submit(): void {
    if (!repo) return
    localStorage.setItem('agent-fleet.chatDefault', chat ? 'on' : 'off')
    localStorage.setItem('agent-fleet.detachedDefault', detached ? 'on' : 'off')
    onLaunch({ repoPath: repo.path, prompt: prompt.trim(), name: name.trim(), worktree, browser, chat, detached })
    setPrompt('')
    setName('')
  }

  if (!open) return null
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/50 pt-24" onMouseDown={onClose}>
      <div
        className="w-[560px] rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--line)] px-5 py-3 text-[13px] font-semibold">New agent</div>
        <div className="space-y-4 px-5 py-4 text-[12px]">
          <div>
            <div className="mb-1.5 text-[var(--muted)]">repo</div>
            <div className="flex flex-wrap gap-1.5">
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
            {repo && <div className="mt-1 font-mono text-[10.5px] text-[var(--dim)]">{repo.path}</div>}
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
              rows={4}
              placeholder="what should it do? leave empty for an interactive session"
              className="select w-full resize-none rounded border border-[var(--line)] bg-[var(--ink)] px-3 py-2 outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="flex items-center gap-5">
            <label className="flex items-center gap-2">
              <span className="text-[var(--muted)]">name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="auto from prompt"
                className="select w-40 rounded border border-[var(--line)] bg-[var(--ink)] px-2 py-1 font-mono outline-none focus:border-[var(--accent)]"
              />
            </label>
            <Toggle on={worktree} set={(v) => repo && canWorktree(repo) && setWorktree(v)} label="own worktree + branch" />
            <Toggle on={browser} set={setBrowser} label="browser" />
            <Toggle on={chat} set={setChat} label="chat view" />
            <Toggle on={detached} set={setDetached} label="keep running when the app closes" />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3">
          <span className="text-[11px] text-[var(--dim)]">↩ launch · ⇧↩ newline · esc close</span>
          <button
            disabled={!repo}
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

function Toggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button onClick={() => set(!on)} className="flex items-center gap-2 text-[var(--muted)]">
      <span className={`h-3.5 w-6 rounded-full p-0.5 transition ${on ? 'bg-[var(--accent)]' : 'bg-[var(--line)]'}`}>
        <span className={`block h-2.5 w-2.5 rounded-full bg-[var(--ink)] transition ${on ? 'translate-x-2.5' : ''}`} />
      </span>
      {label}
    </button>
  )
}
