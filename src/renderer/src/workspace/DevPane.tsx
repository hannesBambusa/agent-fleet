import { useCallback, useEffect, useState } from 'react'
import type { DevProject, DevServer } from '../../../shared/types'
import { Terminal, termSize } from '../terminal/Terminal'
import { openLink } from '../state/openLink'

const POLL_MS = 4000

/**
 * The dev servers for this repository, and starting one for this worktree.
 *
 * Two agents on one repo means two checkouts of the same app, and the moment either wants to look at
 * it in a browser the question is which server is whose, and which of them is holding port 3000.
 * That is answered by working directory, not by guesswork: a server is found where it runs.
 *
 * Starting one from here runs it in this agent's own directory, so the page you open is the code the
 * agent has actually written, rather than whatever the main checkout happens to contain.
 */
export function DevPane({ repoPath, cwd, agentId }: { repoPath: string; cwd: string; agentId: string | null }): JSX.Element {
  const [project, setProject] = useState<DevProject | null>(null)
  const [list, setList] = useState<DevServer[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [started, setStarted] = useState(false)
  const ptyId = `dev:${agentId ?? cwd}`

  const refresh = useCallback(async (): Promise<void> => {
    setList(await window.api.dev.servers(repoPath).catch(() => []))
  }, [repoPath])

  useEffect(() => {
    void window.api.dev.project(cwd).then(setProject)
  }, [cwd])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // a terminal started earlier is still alive behind the tab; show it again rather than start twice
  useEffect(() => {
    void window.api.pty.history(ptyId).then((h) => setStarted(h.length > 0))
  }, [ptyId])

  const here = (list ?? []).filter((s) => s.cwd === cwd)
  const elsewhere = (list ?? []).filter((s) => s.cwd !== cwd)

  async function stop(s: DevServer): Promise<void> {
    setBusy(s.pgid)
    try {
      await window.api.dev.stop(s.pgid)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  function start(): void {
    if (!project?.command) return
    const { cols, rows } = termSize()
    void window.api.dev.start(ptyId, cwd, project.command, cols, rows).then(() => {
      setStarted(true)
      setTimeout(() => void refresh(), 2500)
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-1.5">
        <span className="lbl">dev</span>
        <span className="mono text-[10px] text-[var(--dim)]">
          {project ? `${project.framework ?? 'node'} · ${project.command ?? 'no dev script'}` : 'not a node project'}
        </span>
        {project?.command && !here.length && (
          <button onClick={start} className="chip chip-running ml-auto shrink-0 hover:brightness-110">
            start here
          </button>
        )}
        {!!here.length && <span className="lbl ml-auto shrink-0 !text-[var(--accent)]">running here</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {list === null && <div className="px-3 py-2 text-[11px] text-[var(--dim)]">looking…</div>}

        {!!here.length && (
          <Group title="this worktree" servers={here} busy={busy} onStop={stop} agentId={agentId} />
        )}
        {!!elsewhere.length && (
          <Group
            title={`elsewhere in ${repoPath.split('/').pop()}`}
            servers={elsewhere}
            busy={busy}
            onStop={stop}
            agentId={agentId}
          />
        )}
        {list !== null && !list.length && (
          <div className="px-3 py-2 text-[11px] text-[var(--dim)]">
            nothing running for this repository
            {project?.command ? ' · start one above and it runs in this worktree' : ''}
          </div>
        )}

        {started && (
          <div className="mt-1 border-t border-[var(--line)]">
            <div className="lbl px-3 py-1.5">output</div>
            <div className="h-[280px]">
              <Terminal id={ptyId} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Group({
  title,
  servers,
  busy,
  onStop,
  agentId
}: {
  title: string
  servers: DevServer[]
  busy: number | null
  onStop: (s: DevServer) => void
  /** whose browser pane a port opens in; without an agent there is no pane to open it in */
  agentId: string | null
}): JSX.Element {
  return (
    <div className="border-b border-[var(--line)] px-3 py-2">
      <div className="lbl mb-1.5">
        {title} · {servers.length}
      </div>
      {servers.map((s) => (
        <div key={s.pgid} className="mb-1.5 flex items-baseline gap-2 last:mb-0">
          <span
            className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full"
            style={{ background: s.ports.length ? 'var(--accent)' : 'var(--warn)' }}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="mono block truncate text-[11px]">
              {s.ports.length ? (
                s.ports.map((p) => (
                  <span key={p} className="mr-2 inline-flex items-baseline gap-1">
                    {/* the agent's own pane by default: the point of the pane is watching what this
                        agent built, and a page in a window behind the app is not that */}
                    <button
                      onClick={() => openLink(`http://localhost:${p}`, agentId)}
                      title={`open localhost:${p} in this agent's browser`}
                      className="text-[var(--accent)] underline decoration-[var(--accent)]/30 hover:decoration-[var(--accent)]"
                    >
                      :{p}
                    </button>
                    <button
                      onClick={() => void window.api.shell.openExternal(`http://localhost:${p}`)}
                      title="open in your own browser instead"
                      className="text-[9px] text-[var(--dim)] hover:text-[var(--fg)]"
                    >
                      ↗
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-[var(--warn)]">starting…</span>
              )}
              <span className="text-[var(--dim)]">{s.worktree ?? 'main checkout'}</span>
            </span>
            <span className="mono block truncate text-[9.5px] text-[var(--dim)]" title={s.command}>
              pid {s.pid} · {s.command}
            </span>
          </span>
          <button
            onClick={() => onStop(s)}
            disabled={busy === s.pgid}
            title="stop this server and anything it started"
            className="chip shrink-0 hover:!text-[var(--danger)] disabled:opacity-40"
          >
            {busy === s.pgid ? 'stopping…' : 'stop'}
          </button>
        </div>
      ))}
    </div>
  )
}
