import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DIR = join(homedir(), '.claude', 'topics')

export function topicFor(sessionId: string, cwd: string): string | null {
  const bySession = join(DIR, `${sessionId}.topic`)
  if (existsSync(bySession)) return readFileSync(bySession, 'utf8').trim() || null
  const byCwd = join(DIR, `${cwd.replace(/\//g, '_').replace(/^_/, '')}.topic`)
  if (existsSync(byCwd)) return readFileSync(byCwd, 'utf8').trim() || null
  return null
}
