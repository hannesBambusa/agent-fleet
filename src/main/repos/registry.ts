import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import type { Repo } from '../../shared/types'

const FILE = (): string => join(app.getPath('userData'), 'repos.json')

function trustedPaths(): Set<string> {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
    return new Set(Object.entries(d.projects ?? {}).filter(([, v]) => v.hasTrustDialogAccepted).map(([k]) => k))
  } catch {
    return new Set()
  }
}

function hasCommits(path: string): boolean {
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--verify', '-q', 'HEAD'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The repository a path belongs to.
 *
 * An agent's worktree sits at `<repo>/.claude/worktrees/<name>` and carries a `.git` *file*, so it
 * looks like a repository to any existence check and was being registered as one. That put entries
 * called `agent-2` in the repo list and made everything scoped to a project read as belonging to the
 * worktree rather than to the project.
 */
function repoRoot(path: string): string {
  const parent = dirname(path)
  if (basename(parent) === 'worktrees' && basename(dirname(parent)) === '.claude') return dirname(dirname(parent))
  return path
}

export class RepoRegistry {
  private repos = new Map<string, Repo>()

  constructor() {
    try {
      const list = JSON.parse(readFileSync(FILE(), 'utf8')) as Repo[]
      let migrated = false
      for (const r of list) {
        const root = repoRoot(r.path)
        if (root !== r.path) {
          // an entry recorded before worktrees were recognised: fold it into its repository
          migrated = true
          if (!this.repos.has(root)) this.repos.set(root, { ...r, path: root, name: basename(root) })
          continue
        }
        this.repos.set(r.path, r)
      }
      if (migrated) this.save()
    } catch {
      // first run
    }
  }

  list(): Repo[] {
    const trusted = trustedPaths()
    return [...this.repos.values()]
      .map((r) => ({ ...r, trusted: trusted.has(r.path), hasCommits: hasCommits(r.path) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(path: string): Repo | undefined {
    return this.repos.get(path)
  }

  // register a path seen in a session's cwd, keeping defaults if already known
  seen(cwd: string): void {
    const path = repoRoot(cwd)
    if (this.repos.has(path) || !existsSync(join(path, '.git'))) return
    this.repos.set(path, { path, name: basename(path), trusted: false, hasCommits: false, worktree: true, browser: true, setupCommand: '' })
    this.save()
  }

  upsert(r: Repo): Repo {
    this.repos.set(r.path, { ...r, name: basename(r.path) })
    this.save()
    return this.repos.get(r.path)!
  }

  remove(path: string): void {
    this.repos.delete(path)
    this.save()
  }

  private save(): void {
    writeFileSync(FILE(), JSON.stringify(this.list(), null, 2))
  }
}
