import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { titleFor } from './titles'

const DIR = join(homedir(), '.claude', 'topics')

/**
 * What to call a session, best answer first.
 *
 * A topic file is an explicit statement of what this session is for, so it wins. Failing that,
 * Claude Code's own title for the conversation is far better than anything derived from a first
 * prompt or a directory name.
 */
export function topicFor(sessionId: string, cwd: string): string | null {
  const bySession = join(DIR, `${sessionId}.topic`)
  if (existsSync(bySession)) return readFileSync(bySession, 'utf8').trim() || null
  const byCwd = join(DIR, `${cwd.replace(/\//g, '_').replace(/^_/, '')}.topic`)
  if (existsSync(byCwd)) return readFileSync(byCwd, 'utf8').trim() || null
  return titleFor(sessionId)
}
