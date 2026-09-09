import { execFile } from 'node:child_process'

const REFRESH_MS = 4000

interface Run {
  ok: boolean
  out: string
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
      const res = await sh('pgrep', ['-x', 'claude'], [1])
      if (!res.ok) return
      const pids = res.out.split('\n').map((l) => l.trim()).filter(Boolean)
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
