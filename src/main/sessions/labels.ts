import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionLabel } from '../../shared/types'

// Beside the app's other state under ~/.claude rather than in Electron's userData, so this module
// pulls in nothing from Electron: the session tailer imports it, and the tailer is plain logic that
// has to stay testable without a browser or an app object.
const DIR = join(homedir(), '.claude', 'agent-fleet')
const FILE = (): string => join(DIR, 'labels.json')
const TOPICS = join(homedir(), '.claude', 'topics')

/**
 * What you decided a session is, as opposed to what it can be worked out to be.
 *
 * Claude Code names a session from the work, which is a good guess and sometimes the wrong one: two
 * agents in the same repo end up with titles that read alike, and a session that changed direction
 * keeps the name of what it started as. A name you typed always wins over a derived one.
 *
 * The name is also written to `~/.claude/topics/<id>.topic`, which is where the status line reads
 * its topic from, so naming an agent here names it in the terminal too.
 */
let cache: Record<string, SessionLabel> | null = null

function all(): Record<string, SessionLabel> {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(FILE(), 'utf8')) as Record<string, SessionLabel>
  } catch {
    cache = {}
  }
  return cache
}

export function labelFor(sessionId: string): SessionLabel | null {
  return all()[sessionId] ?? null
}

export function setLabel(sessionId: string, label: SessionLabel): SessionLabel | null {
  const next = { ...all() }
  const name = label.name.trim()
  const note = label.note.trim()
  if (!name && !note) delete next[sessionId]
  else next[sessionId] = { name, note }
  cache = next
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('[labels] could not save', err)
  }
  writeTopic(sessionId, name)
  return next[sessionId] ?? null
}

/** The file the status line reads, so the terminal shows the same name. */
function writeTopic(sessionId: string, name: string): void {
  const file = join(TOPICS, `${sessionId}.topic`)
  try {
    if (!name) {
      rmSync(file, { force: true })
      return
    }
    mkdirSync(TOPICS, { recursive: true })
    writeFileSync(file, `${name}\n`)
  } catch (err) {
    console.error('[labels] could not write the topic file', err)
  }
}
