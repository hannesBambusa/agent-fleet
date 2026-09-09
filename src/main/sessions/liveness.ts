import { execFile } from 'node:child_process'
import { basename } from 'node:path'

const REFRESH_MS = 4000

// The plumbing that runs under the same name as a session: the background daemon, a pty host, a
// spare pty waiting to be claimed, and a client attached to a session running somewhere else.
// Counting any of them as a session inflates a directory's live count and keeps dead cards on screen.
const HELPER_ARGS = new Set(['daemon', 'attach', 'bg-pty-host', 'bg-spare', '--bg-pty-host', '--bg-spare'])

interface Run {
  ok: boolean
  out: string
}

/**
 * The pid in one `pgrep -fl` line, if that line is a `claude` process actually running a session.
 *
 * The launcher picks argv[0], so a name match cannot see all of them: agents this app starts get a
 * bare `claude`, `~/.local/bin/claude` is the entrypoint script, and a session started from a
 * terminal ends up on the versioned binary under `~/.local/share/claude/versions/<version>`, whose
 * process name is a version number. Hence the executable is judged by path.
 *
 * The helpers are dropped on their first argument alone, which is the only place the marker can be
 * trusted: a pty host repeats the versioned binary path after a `--`, and text handed to
 * `--append-system-prompt` can contain any of these words by chance.
 */
function sessionPid(line: string): string | null {
  const [pid, exe, arg] = line.trim().split(/\s+/, 3)
  if (!pid || !exe) return null
  if (basename(exe) !== 'claude' && !exe.includes('/share/claude/versions/')) return null
  if (arg && HELPER_ARGS.has(arg)) return null
  return pid
}

// pgrep exits 1 when it simply matched nothing, which is a real answer rather than a failure
function sh(cmd: string, args: string[], emptyExitCodes: number[] = []): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      if (!err) return resolve({ ok: true, out: stdout })
      const code = (err as { code?: number }).code
      if (typeof code === 'number' && emptyExitCodes.includes(code)) return resolve({ ok: true, out: '' })
      resolve({ ok: !!stdout, out: stdout })
    })
  })
}

/**
 * How many `claude` processes are alive in each directory.
 *
 * Claude Code appends to its transcript and closes the file again, so an open file handle cannot
 * be used to tell a live session from one whose terminal was closed hours ago. The working
 * directory of every running process is the next best signal: N processes in a directory means the
 * N most recently active sessions there are the live ones.
 */
export class Liveness {
  private byCwd = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private scanned = false

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  countFor(cwd: string): number {
    return this.byCwd.get(cwd) ?? 0
  }

  /** true until a scan has actually succeeded, so nothing is hidden while the answer is unknown */
  get unknown(): boolean {
    return !this.scanned
  }

  private async refresh(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      // 1 = no process matched. Anything else means the scan failed, and a failed scan must never
      // be read as "nothing is running": that would un-hide every closed session at once.
      const res = await sh('pgrep', ['-fl', 'claude'], [1])
      if (!res.ok) return
      const pids = res.out.split('\n').map(sessionPid).filter((p): p is string => p !== null)
      if (!pids.length) {
        this.byCwd = new Map()
        this.scanned = true
        return
      }
      const lsof = await sh('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'])
      if (!lsof.ok) return
      const next = new Map<string, number>()
      for (const line of lsof.out.split('\n')) {
        if (!line.startsWith('n/')) continue
        const dir = line.slice(1)
        next.set(dir, (next.get(dir) ?? 0) + 1)
      }
      if (!next.size) return
      this.byCwd = next
      this.scanned = true
    } finally {
      this.busy = false
    }
  }
}
