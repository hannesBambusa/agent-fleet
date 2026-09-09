import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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

export class RepoRegistry {
  private repos = new Map<string, Repo>()

  constructor() {
    try {
      const list = JSON.parse(readFileSync(FILE(), 'utf8')) as Repo[]
      for (const r of list) this.repos.set(r.path, r)
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
  seen(path: string): void {
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
