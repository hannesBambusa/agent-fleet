import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SeedItem, SeedPlan } from '../../shared/types'

/**
 * A worktree is a fresh checkout, so it contains only what git tracks. Everything a project needs to
 * actually run and is deliberately not committed — `.env` above all — is simply absent, and an agent
 * in a worktree hits that on its first command. This carries those files across.
 *
 * Two kinds, treated differently. Secrets and local config are small and are *copied*, so the agent
 * cannot corrupt the originals. Dependency directories are large and are *linked*, because copying
 * node_modules per agent is minutes of IO and gigabytes of disk.
 */

// files worth carrying: config that is ignored on purpose and needed to run
const COPY = [
  /^\.env(\..+)?$/,
  /\.env$/,
  /^\.npmrc$/,
  /^\.yarnrc(\.yml)?$/,
  /^\.tool-versions$/,
  /^\.python-version$/,
  /^\.ruby-version$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^credentials\.json$/,
  /^service-account.*\.json$/,
  /^\.secrets(\..+)?$/,
  /^local\.settings\.json$/
]
// directories worth linking: installed dependencies, never build output
const LINK = ['node_modules', 'vendor', '.venv', 'venv', '.bundle', 'Pods', '.yarn']
// never carried, whatever the pattern says: agent checkouts, review scratch, editor and OS litter
const SKIP = ['.claude', '.git', 'commit', '.DS_Store', '.idea']
const MAX_COPY = 4 * 1024 * 1024

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) => resolve(stdout))
  })
}

function base(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * What the main checkout has that this worktree does not. Read-only: nothing is copied until the
 * caller says so, and an item already present in the worktree is reported as done rather than hidden,
 * so the panel can show the whole picture.
 */
export async function seedPlan(repoPath: string, worktree: string): Promise<SeedPlan> {
  const out = await git(repoPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
  const raw = out.split('\0').filter(Boolean)
  // `--directory` collapses a directory but git still lists files under it; drop those
  const dirs = raw.filter((p) => p.endsWith('/'))
  const paths = raw.filter((p) => !dirs.some((d) => p !== d && p.startsWith(d)))

  const items: SeedItem[] = []
  for (const p of paths) {
    const clean = p.replace(/\/$/, '')
    const name = base(clean)
    if (SKIP.includes(name) || clean.split('/').some((seg) => SKIP.includes(seg))) continue

    const isDir = p.endsWith('/')
    const from = join(repoPath, clean)
    let size = 0
    try {
      size = isDir ? 0 : statSync(from).size
    } catch {
      continue
    }
    const kind = isDir ? (LINK.includes(name) ? 'link' : null) : COPY.some((re) => re.test(name)) && size <= MAX_COPY ? 'copy' : null
    if (!kind) continue
    items.push({ path: clean, kind, size, present: existsSync(join(worktree, clean)) })
  }
  // config first, then the heavy directories
  items.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'copy' ? -1 : 1))
  return { repoPath, worktree, items }
}

/** Carries the named items across. Never overwrites anything the worktree already has. */
export function seedApply(repoPath: string, worktree: string, items: SeedItem[]): { done: string[]; failed: string[] } {
  const done: string[] = []
  const failed: string[] = []
  for (const it of items) {
    const from = join(repoPath, it.path)
    const to = join(worktree, it.path)
    try {
      if (existsSync(to) || lstatSync(to, { throwIfNoEntry: false })) {
        continue
      }
      mkdirSync(dirname(to), { recursive: true })
      if (it.kind === 'link') symlinkSync(from, to, 'dir')
      else copyFileSync(from, to)
      done.push(it.path)
    } catch {
      failed.push(it.path)
    }
  }
  return { done, failed }
}

/**
 * What a new worktree gets without being asked: the config it cannot run without. Linking a
 * dependency directory is left to the user, since it ties two checkouts together and an agent that
 * reinstalls would then be reinstalling the main checkout's copy.
 */
export async function seedAuto(repoPath: string, worktree: string): Promise<string[]> {
  const plan = await seedPlan(repoPath, worktree)
  const wanted = plan.items.filter((i) => i.kind === 'copy' && !i.present)
  if (!wanted.length) return []
  return seedApply(repoPath, worktree, wanted).done
}
