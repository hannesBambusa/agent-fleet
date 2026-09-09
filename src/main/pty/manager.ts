import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'

export interface PtyOpts {
  cwd: string
  cols: number
  rows: number
  // run through the user's login shell so PATH and auth match iTerm
  command: string
  env?: Record<string, string>
}

const HISTORY_BYTES = 200_000

/**
 * Claude Code marks its own children through the environment, and an agent must never be taken for
 * one: `CLAUDE_CODE_CHILD_SESSION` turns transcript saving off, so an agent started by an app that
 * was itself started from inside a Claude Code session writes no JSONL at all. That file is how this
 * app sees anything, so the agent then runs perfectly while its card stays empty and its chat blank.
 * The rest identify the parent session and its message channel, which are not this agent's.
 */
const PARENT_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT'
]

function ownSession(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PARENT_MARKERS.includes(k)) out[k] = v
  return out
}

export class PtyManager extends EventEmitter {
  private procs = new Map<string, pty.IPty>()
  // last output per id, replayed into a terminal pane that mounts after the fact
  private history = new Map<string, string>()

  spawn(id: string, o: PtyOpts): void {
    this.kill(id)
    this.history.delete(id)
    const shell = process.env['SHELL'] || '/bin/zsh'
    const p = pty.spawn(shell, ['-lc', o.command], {
      name: 'xterm-256color',
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: { ...ownSession(process.env), ...o.env, TERM_PROGRAM: 'agent-fleet', COLORTERM: 'truecolor' }
    })
    this.procs.set(id, p)
    p.onData((data) => {
      const h = (this.history.get(id) ?? '') + data
      this.history.set(id, h.length > HISTORY_BYTES ? h.slice(-HISTORY_BYTES) : h)
      this.emit('data', id, data)
    })
    p.onExit(({ exitCode }) => {
      this.procs.delete(id)
      this.emit('exit', id, exitCode)
    })
  }

  write(id: string, data: string): void {
    this.procs.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.procs.get(id)
    if (p && cols > 0 && rows > 0) p.resize(cols, rows)
  }

  kill(id: string): void {
    const p = this.procs.get(id)
    if (!p) return
    this.procs.delete(id)
    try {
      p.kill()
    } catch {
      // already gone
    }
  }

  historyOf(id: string): string {
    return this.history.get(id) ?? ''
  }

  alive(id: string): boolean {
    return this.procs.has(id)
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id)
  }
}
