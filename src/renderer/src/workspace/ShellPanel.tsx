import { useEffect, useState } from 'react'
import { Terminal, termSize } from '../terminal/Terminal'

/** `/Users/you/code/backend/.claude/worktrees/agent-2` is unreadable at this size; this is not. */
function shortPath(path: string, home: string): string {
  const p = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  // a worktree's own name matters more than the four segments that get it there
  return p.replace('/.claude/worktrees/', ' ⑂ ')
}

/**
 * A shell, dressed as one.
 *
 * The agent has its own terminal; this is the one you type in yourself, so it says whose directory it
 * is in and gives you the two things a person reaches for when a shell misbehaves: clear it, or start
 * it again. The prompt glyph and the darker ground are there to make it obvious at a glance which of
 * the two terminals on screen is yours.
 */
export function ShellPanel({ id, cwd, onClose }: { id: string; cwd: string; onClose: () => void }): JSX.Element {
  const [restarting, setRestarting] = useState(false)
  const home = window.api.home

  useEffect(() => {
    const { cols, rows } = termSize()
    void window.api.pty.open(id, cwd, cols, rows)
  }, [id, cwd])

  function restart(): void {
    setRestarting(true)
    void window.api.pty
      .close(id)
      .then(() => {
        const { cols, rows } = termSize()
        return window.api.pty.open(id, cwd, cols, rows)
      })
      .finally(() => setRestarting(false))
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ink)]">
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-1"
        style={{
          // a hairline of accent along the top, so the panel reads as a thing rather than a gap
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--accent) 35%, transparent)',
          background: 'color-mix(in srgb, var(--accent) 6%, var(--panel))'
        }}
      >
        <span className="mono shrink-0 text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
          ❯
        </span>
        <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-[var(--muted)]" title={cwd}>
          {shortPath(cwd, home)}
        </span>
        <span className="lbl shrink-0">your shell</span>
        <button
          onClick={() => window.api.pty.write(id, 'clear\r')}
          title="clear the screen"
          className="lbl shrink-0 hover:!text-[var(--accent)]"
        >
          clear
        </button>
        <button
          onClick={restart}
          disabled={restarting}
          title="kill it and start a fresh one here"
          className="lbl shrink-0 hover:!text-[var(--warn)] disabled:opacity-40"
        >
          {restarting ? 'restarting…' : 'restart'}
        </button>
        <button onClick={onClose} title="close the shell (it keeps running)" className="lbl shrink-0 hover:!text-[var(--fg)]">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 px-1 pb-1">
        <Terminal id={id} />
      </div>
    </div>
  )
}
