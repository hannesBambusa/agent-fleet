import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SlashCommand } from '../../shared/types'

const HOME = homedir()
const PERSONAL_DIR = join(HOME, '.claude', 'commands')
const PLUGINS_FILE = join(HOME, '.claude', 'plugins', 'installed_plugins.json')

/**
 * Commands Claude Code answers to that exist nowhere on disk, so nothing can discover them.
 *
 * This list will drift as Claude Code changes: it is a convenience for the composer, not a contract.
 * A command that has been renamed upstream shows up here as an entry that does nothing, which is why
 * it stays short and holds only the ones people reach for.
 */
const BUILTIN: Array<[string, string]> = [
  ['/init', 'write a CLAUDE.md for this repository'],
  ['/clear', 'start a new conversation'],
  ['/compact', 'summarise the conversation so far'],
  ['/model', 'switch model'],
  ['/mcp', 'manage MCP servers'],
  ['/agents', 'manage subagents'],
  ['/skills', 'list skills'],
  ['/plugin', 'manage plugins'],
  ['/resume', 'pick an earlier conversation'],
  ['/diff', 'show the working tree diff'],
  ['/cost', 'tokens and cost for this session'],
  ['/status', 'version, account and connection'],
  ['/help', 'list commands'],
  ['/exit', 'quit Claude Code']
]

/** a path the scan read, with the mtime it had; a missing path stamps as 0 so appearing counts */
interface Stamp {
  path: string
  mtime: number
}

interface Cached {
  commands: SlashCommand[]
  stamps: Stamp[]
}

// keyed by cwd, because project and project-scoped plugin commands differ per directory
const cache = new Map<string, Cached>()

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Every `.md` under a command directory, named the way Claude Code names it.
 *
 * A subdirectory is a namespace rather than a group, so `git/sync.md` is `/git:sync`. The directory
 * itself is stamped whether or not it exists: a personal command directory is created the first time
 * someone writes a command, and that has to invalidate the cache like any other change.
 */
function walk(dir: string, stamps: Stamp[], prefix = ''): Array<{ name: string; file: string }> {
  stamps.push({ path: dir, mtime: mtimeOf(dir) })
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ name: string; file: string }> = []
  for (const e of entries) {
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), stamps, `${prefix}${e.name}:`))
    else if (e.name.endsWith('.md')) out.push({ name: `${prefix}${e.name.slice(0, -'.md'.length)}`, file: join(dir, e.name) })
  }
  return out
}

/**
 * The `description:` line of a command file's YAML frontmatter.
 *
 * Only the frontmatter is read. The body is the prompt the command sends, often pages of it, and a
 * `description:` written in there is prose about something else. A file without frontmatter gets an
 * empty description rather than a first line pressed into service as one.
 */
function descriptionOf(file: string): string {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  if (!text.startsWith('---')) return ''
  const end = text.indexOf('\n---', 3)
  if (end < 0) return ''
  const m = /^description:[ \t]*(.*)$/m.exec(text.slice(0, end))
  if (!m) return ''
  return m[1].trim().replace(/^["']|["']$/g, '')
}

/** true when cwd is inside projectPath, which is how a project-scoped plugin claims a directory */
function under(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
}

interface InstalledEntry {
  scope?: string
  projectPath?: string
  installPath?: string
}

/**
 * Commands from installed plugins, one entry per plugin.
 *
 * `installPath` is the only thing that says which version is live. The cache keeps every version a
 * plugin has ever had side by side, seven directories for `code-review` on this machine, so listing
 * the cache would offer the same command seven times over, most of them code nothing runs any more.
 */
function pluginCommands(cwd: string, stamps: Stamp[]): SlashCommand[] {
  stamps.push({ path: PLUGINS_FILE, mtime: mtimeOf(PLUGINS_FILE) })
  let doc: { plugins?: Record<string, InstalledEntry[]> }
  try {
    doc = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')) as { plugins?: Record<string, InstalledEntry[]> }
  } catch {
    return []
  }
  const out: SlashCommand[] = []
  for (const [key, entries] of Object.entries(doc.plugins ?? {})) {
    const list = entries ?? []
    const chosen =
      list.find((e) => e.scope === 'project' && e.projectPath && under(cwd, e.projectPath)) ??
      list.find((e) => e.scope === 'user')
    if (!chosen?.installPath) continue
    // the marketplace suffix is not part of the command: `caveman@caveman` types as `/caveman:…`
    const plugin = key.split('@')[0]
    for (const c of walk(join(chosen.installPath, 'commands'), stamps)) {
      out.push({ name: `/${plugin}:${c.name}`, description: descriptionOf(c.file), source: 'plugin' })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function fromDir(dir: string, source: SlashCommand['source'], stamps: Stamp[]): SlashCommand[] {
  return walk(dir, stamps)
    .map((c) => ({ name: `/${c.name}`, description: descriptionOf(c.file), source }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every `.claude/commands` a session in `cwd` inherits, nearest first.
 *
 * `.claude` state comes down the tree rather than sitting in the working directory: this machine
 * keeps its only project command in `~/repos/.claude/commands`, one level above every repository, so
 * looking in the working directory alone finds nothing at all. The walk stops at the home directory,
 * whose `.claude/commands` is the personal source and is read there instead, and it never leaves it:
 * a directory outside home has no ancestors worth asking about.
 *
 * A worktree at `<repo>/.claude/worktrees/<name>` reaches the repository's own commands and
 * everything above it by the same walk, which is the case that makes this more than a nicety.
 */
function commandDirs(cwd: string): string[] {
  const dirs: string[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(join(dir, '.claude', 'commands'))
    if (dir === HOME || !under(dir, HOME) || dirname(dir) === dir) break
  }
  return dirs.filter((d) => d !== PERSONAL_DIR)
}

function scan(cwd: string): Cached {
  const stamps: Stamp[] = []
  const groups = [
    commandDirs(cwd).flatMap((d) => fromDir(d, 'project', stamps)),
    fromDir(PERSONAL_DIR, 'personal', stamps),
    pluginCommands(cwd, stamps),
    BUILTIN.map(([name, description]) => ({ name, description, source: 'builtin' as const }))
  ]
  const seen = new Set<string>()
  const commands: SlashCommand[] = []
  for (const group of groups) {
    for (const c of group) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      commands.push(c)
    }
  }
  return { commands, stamps }
}

/**
 * Every slash command available to a session in `cwd`, most specific source first.
 *
 * The composer asks on every mount and the scan walks a dozen directories, so the result is held per
 * cwd and reused until one of the directories it read has changed. A directory's mtime moves when an
 * entry is added or removed, which is what this cache is for; editing the text inside an existing
 * command file does not move it, so a changed description shows up on the next restart.
 */
export function slashCommands(cwd: string): SlashCommand[] {
  const hit = cache.get(cwd)
  if (hit && hit.stamps.every((s) => mtimeOf(s.path) === s.mtime)) return hit.commands
  const fresh = scan(cwd)
  cache.set(cwd, fresh)
  return fresh.commands
}
