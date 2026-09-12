import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DevProject, DevServer } from '../../shared/types'

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (_e, stdout) => resolve(stdout ?? ''))
  })
}

/**
 * What kind of project this is, and how its dev server is started.
 *
 * Read from package.json rather than guessed: the script name is whatever the project calls it, and
 * the package manager is whichever lockfile is committed, because running `npm` in a pnpm project
 * is a good way to rewrite someone's lockfile by accident.
 */
export function projectOf(dir: string): DevProject | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const scripts = pkg.scripts ?? {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const script = ['dev', 'start', 'serve', 'develop'].find((s) => scripts[s]) ?? null
  const framework =
    (deps['electron-vite'] && 'electron-vite') ||
    (deps['next'] && 'next') ||
    (deps['@remix-run/dev'] && 'remix') ||
    (deps['astro'] && 'astro') ||
    (deps['nuxt'] && 'nuxt') ||
    (deps['@sveltejs/kit'] && 'sveltekit') ||
    (deps['vite'] && 'vite') ||
    (deps['react-scripts'] && 'create-react-app') ||
    (deps['nodemon'] && 'nodemon') ||
    null
  const manager = existsSync(join(dir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(dir, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(dir, 'bun.lockb'))
        ? 'bun'
        : 'npm'
  return { dir, framework, script, manager, command: script ? `${manager} run ${script}` : null }
}

// Frameworks that take `--port` on the command line. Everything else is given PORT in the
// environment, which is what the rest of the node world reads.
const PORT_FLAG = /^(vite|electron-vite|next|nuxt|astro|remix|gatsby|parcel|webpack-dev-server|react-scripts)$/i

/**
 * The same dev command, told to listen somewhere else.
 *
 * Two agents on one repository run the same script, and the second one dies on the port the first
 * is holding. The flag goes after `--` so the package manager passes it through to the framework
 * rather than eating it, and it goes last so it overrides a port baked into the script itself.
 */
export function onPort(project: DevProject, port: number): string {
  if (!project.command) return ''
  if (project.framework && PORT_FLAG.test(project.framework)) {
    return `${project.command} -- --port ${port}`
  }
  return `PORT=${port} ${project.command}`
}

/**
 * A port nothing is listening on, counting up from a base.
 *
 * Asked of the operating system rather than of a list of what this app started: the port a
 * colleague's server or a stopped-but-not-dead process is holding is just as taken.
 */
export async function freePort(from = 3100, tries = 40): Promise<number> {
  const busy = new Set<number>()
  const out = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  for (const line of out.split('\n')) {
    const m = /:(\d+)\s+\(LISTEN\)/.exec(line)
    if (m) busy.add(Number(m[1]))
  }
  for (let p = from; p < from + tries; p++) if (!busy.has(p)) return p
  return from
}

// The executables that are a dev server, matched on the program being run rather than anywhere in
// the command line: an agent's own command line quotes a system prompt, and a prompt containing the
// word "next" is not Next.js.
const DEV_EXE = /^(vite|next|nuxt|astro|remix|webpack|webpack-dev-server|react-scripts|nodemon|ts-node-dev|electron-vite|rails|gatsby|parcel)$/i
const RUNNERS = /^(npm|pnpm|yarn|bun|npx)$/i
const DEV_SCRIPT = /^(dev|start|serve|develop|dev:.*|start:.*)$/i

interface Proc {
  pid: number
  pgid: number
  command: string
}

/** Is this process a dev server, judged by what it runs rather than by what it says? */
function isDev(command: string): boolean {
  const parts = command.split(/\s+/).filter(Boolean)
  if (!parts.length) return false
  const base = (p: string): string => (p.split('/').pop() ?? p).replace(/\.(js|mjs|cjs)$/, '')
  const first = base(parts[0])
  // never the agents themselves, whatever their prompt happens to contain
  if (first === 'claude') return false
  // `node /path/to/.bin/vite` is vite; `python manage.py runserver` is django
  const exe = /^(node|bun|deno|ts-node)$/i.test(first) && parts[1] ? base(parts[1]) : first
  if (DEV_EXE.test(exe)) return true
  if (/^python/i.test(first) && parts.includes('runserver')) return true
  if (RUNNERS.test(exe)) {
    const args = parts.slice(1).filter((a) => a !== 'run' && !a.startsWith('-'))
    return args.some((a) => DEV_SCRIPT.test(a))
  }
  return false
}

async function candidates(): Promise<Proc[]> {
  const out = await sh('ps', ['-Ao', 'pid=,pgid=,command='])
  const list: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const command = m[3].trim()
    if (!isDev(command)) continue
    list.push({ pid: Number(m[1]), pgid: Number(m[2]), command })
  }
  return list
}

/** Working directory per pid, which is the only reliable way to say which repo a server belongs to. */
async function cwds(pids: number[]): Promise<Map<number, string>> {
  const out = await sh('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'])
  const map = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1))
  }
  return map
}

/** The TCP ports each pid is listening on, which is what you actually want to click. */
async function ports(pids: number[]): Promise<Map<number, number[]>> {
  const out = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(','), '-Fn'])
  const map = new Map<number, number[]>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const port = Number(/:(\d+)$/.exec(line.slice(1))?.[1])
      if (!port) continue
      const list = map.get(pid) ?? []
      if (!list.includes(port)) list.push(port)
      map.set(pid, list)
    }
  }
  return map
}

/**
 * Dev servers running for this repository, including the ones in its worktrees.
 *
 * Matched by working directory rather than by command line: `pnpm dev` says nothing about where it
 * is, and an agent that starts a server in its own worktree has to be told apart from the one you
 * started in the main checkout.
 */
export async function servers(repoRoot: string): Promise<DevServer[]> {
  const procs = await candidates()
  if (!procs.length) return []
  const pids = procs.map((p) => p.pid)
  const [dirs, listening] = await Promise.all([cwds(pids), ports(pids)])

  // `pnpm dev` and the vite it spawned are one server wearing two pids: they share a process group,
  // so the group is the unit — one row, the ports of whichever member is actually listening.
  const groups = new Map<number, DevServer>()
  for (const p of procs) {
    const cwd = dirs.get(p.pid)
    if (!cwd || (cwd !== repoRoot && !cwd.startsWith(`${repoRoot}/`))) continue
    const own = (listening.get(p.pid) ?? []).filter((n) => n < 49152)
    const existing = groups.get(p.pgid)
    const command = p.command.length > 120 ? `${p.command.slice(0, 120)}…` : p.command
    if (!existing) {
      groups.set(p.pgid, {
        pid: p.pid,
        pgid: p.pgid,
        cwd,
        // "<repo>/.claude/worktrees/agent-2" reads as "agent-2"
        worktree: cwd === repoRoot ? null : cwd.split('/').pop() ?? null,
        command,
        ports: own
      })
      continue
    }
    existing.ports = [...new Set([...existing.ports, ...own])]
    // the member holding the port is the one worth naming and pointing at
    if (own.length) {
      existing.pid = p.pid
      existing.command = command
    }
  }
  // A framework opens more than one socket: this repo's vite also runs a devtools server, so the
  // list held 4206 before the app's own 3003. The port the command was told to use is the app;
  // failing that the lowest, which is where a dev server conventionally sits.
  for (const g of groups.values()) {
    const named = Number(/(?:--port[= ]|PORT=)(\d+)/.exec(g.command)?.[1])
    g.ports.sort((a, b) => Number(b === named) - Number(a === named) || a - b)
  }
  return [...groups.values()].sort(
    (a, b) => Number(b.ports.length > 0) - Number(a.ports.length > 0) || a.pid - b.pid
  )
}

/**
 * Stops a server and whatever it spawned.
 *
 * The whole process group, because `pnpm dev` is a wrapper around the thing actually listening:
 * killing either one alone leaves an orphan holding the port.
 */
export async function stop(pgid: number): Promise<{ ok: boolean; error: string | null }> {
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ESRCH') return { ok: true, error: null }
    return { ok: false, error: e.message }
  }
  // a server that ignores the polite request gets the other one
  await new Promise((r) => setTimeout(r, 1200))
  try {
    process.kill(-pgid, 0)
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // already gone, which is the point
  }
  return { ok: true, error: null }
}
