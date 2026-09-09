import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CatalogItem, CatalogKind } from '../../shared/types'

const CLAUDE = join(homedir(), '.claude')
const PLUGINS = join(CLAUDE, 'plugins', 'cache')

/**
 * What Claude Code can do on this machine, read from the same files it reads.
 *
 * Skills, slash commands and subagents all live as markdown with a frontmatter block, in three
 * places: the user's own home directory, whatever plugins are installed, and each project's own
 * config. There is no index to query, so this walks those directories the way Claude Code does.
 */

/**
 * The subset of YAML these files actually use: one `key: value` per line, plus the folded and
 * literal block forms (`key: >` / `key: |`) that longer descriptions are written in. Anything more
 * than that has never appeared in a skill, a command or an agent definition.
 */
function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const lines = text.slice(3, end).split('\n')
  const out: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      // the block is every following line indented under the key
      const block: string[] = []
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s+\S/.test(lines[i + 1]))) {
        block.push(lines[++i].trim())
      }
      out[key] = block.join(' ').trim()
    } else {
      out[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

// Only the frontmatter and the first paragraph are ever shown, and this scanner reads files from
// plugin caches and project folders, which are the least trusted input it touches. Slicing after the
// read would still decode the whole thing into memory first, so the size is checked before opening.
const MAX_READ = 256 * 1024

function read(path: string): string {
  try {
    if (statSync(path).size > MAX_READ) return ''
    return readFileSync(path, 'utf8').slice(0, 4000)
  } catch {
    return ''
  }
}

/** The first real line of prose, for a file whose frontmatter carries no description. */
function firstLine(text: string): string {
  const body = text.startsWith('---') ? text.slice(text.indexOf('\n---', 3) + 4) : text
  for (const line of body.split('\n')) {
    const l = line.trim()
    if (l && !l.startsWith('#') && !l.startsWith('---')) return l.slice(0, 200)
  }
  return ''
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path).filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
}

function item(kind: CatalogKind, path: string, name: string, source: CatalogItem['source'], origin: string): CatalogItem {
  const text = read(path)
  const fm = frontmatter(text)
  let at: string | null = null
  try {
    at = new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    at = null
  }
  return {
    kind,
    name: fm.name || name,
    description: fm.description || firstLine(text),
    source,
    origin,
    path,
    model: fm.model ?? null,
    tools: fm.tools ?? null,
    hint: fm['argument-hint'] ?? null,
    // one that opts out of model invocation is reachable only by typing it
    userOnly: fm['disable-model-invocation'] === 'true',
    at
  }
}

/** A skill is a directory holding a SKILL.md. */
function skillsIn(root: string, source: CatalogItem['source'], origin: string): CatalogItem[] {
  const base = join(root, 'skills')
  return dirs(base)
    .map((name) => ({ name, file: join(base, name, 'SKILL.md') }))
    .filter((s) => existsSync(s.file))
    .map((s) => item('skill', s.file, s.name, source, origin))
}

/** Commands and agents are single markdown files, one per name. */
function flatIn(kind: CatalogKind, root: string, source: CatalogItem['source'], origin: string): CatalogItem[] {
  const base = join(root, `${kind}s`)
  return dirs(base)
    .filter((n) => n.endsWith('.md'))
    .map((n) => item(kind, join(base, n), basename(n, '.md'), source, origin))
}

function allIn(root: string, source: CatalogItem['source'], origin: string): CatalogItem[] {
  return [
    ...skillsIn(root, source, origin),
    ...flatIn('command', root, source, origin),
    ...flatIn('agent', root, source, origin)
  ]
}

/** Every installed plugin's own root, one revision deep under each marketplace. */
function pluginRoots(): Array<{ root: string; name: string }> {
  const out: Array<{ root: string; name: string }> = []
  for (const market of dirs(PLUGINS)) {
    for (const plugin of dirs(join(PLUGINS, market))) {
      for (const rev of dirs(join(PLUGINS, market, plugin))) {
        const root = join(PLUGINS, market, plugin, rev)
        try {
          if (statSync(root).isDirectory()) out.push({ root, name: plugin })
        } catch {
          // a half-written cache entry is not a plugin
        }
      }
    }
  }
  return out
}

/** An agent's worktree carries the project's config, but it is the project that owns it. */
function repoRoot(path: string): string {
  const parent = dirname(path)
  if (basename(parent) === 'worktrees' && basename(dirname(parent)) === '.claude') return dirname(dirname(parent))
  return path
}

/**
 * The whole scan is synchronous and walks three trees, and three places in the UI ask for it: the
 * catalog tabs, the MCP tab and the slash menu, the last of which remounts per agent. Skills and
 * commands change when a person edits a file, which is rare and never mid-keystroke, so a short
 * window of staleness costs nothing and saves the walk.
 */
const TTL_MS = 20 * 1000
let cached: { at: number; key: string; items: CatalogItem[] } | null = null

export function catalog(repoPaths: string[]): CatalogItem[] {
  const key = repoPaths.join('\u0000')
  if (cached && cached.key === key && Date.now() - cached.at < TTL_MS) return cached.items
  const items = scan(repoPaths)
  cached = { at: Date.now(), key, items }
  return items
}

function scan(repoPaths: string[]): CatalogItem[] {
  const out = [...allIn(CLAUDE, 'user', 'global')]
  for (const p of pluginRoots()) out.push(...allIn(p.root, 'plugin', p.name))
  // several worktrees of one repository would otherwise list its skills once each
  for (const repo of [...new Set(repoPaths.map(repoRoot))]) {
    out.push(...allIn(join(repo, '.claude'), 'project', basename(repo)))
  }
  return out.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source)
  )
}
