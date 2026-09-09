import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.claude', 'agent-fleet', 'status')

/**
 * What Claude Code calls a session.
 *
 * It works out a title from the conversation itself, and hands it to the status line as
 * `session_name`, which the app already captures per session for its usage meters. That title beats
 * anything this app can derive from a first prompt, so the fleet uses it wherever there is no topic
 * file saying otherwise.
 */

// a name that is only a worktree directory says nothing; those come from `--name` being forced
const PLACEHOLDER = /^agent(-\d+)?$/i

const cache = new Map<string, { at: number; title: string | null }>()

export function titleFor(sessionId: string): string | null {
  const file = join(DIR, `${sessionId}.json`)
  let at: number
  try {
    at = statSync(file).mtimeMs
  } catch {
    return null
  }
  const seen = cache.get(sessionId)
  // the payload is rewritten several times a second while an agent works, but the title rarely moves
  if (seen && seen.at === at) return seen.title
  let title: string | null = null
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as { session_name?: string }
    const name = d.session_name?.trim()
    title = name && !PLACEHOLDER.test(name) ? name : null
  } catch {
    title = null
  }
  cache.set(sessionId, { at, title })
  return title
}
