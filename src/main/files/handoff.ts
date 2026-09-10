import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const DIR = join('.claude', 'handoff')

/**
 * Puts a handed-over document where the receiving agent can just read it.
 *
 * A document too long to paste into the opening prompt has to be read from disk, and reading a path
 * in someone else's repository is both a permission prompt and a file that could move. Copying it
 * into the agent's own working directory removes both: the prompt can name a relative path, which is
 * the same whatever the worktree ended up being called.
 *
 * It lands under `.claude/handoff`, and the worktree is told to ignore it, so a brief never turns up
 * in the diff the agent is about to commit.
 */
export async function placeHandoff(cwd: string, source: string): Promise<string | null> {
  try {
    if (!existsSync(source)) return null
    const dir = join(cwd, DIR)
    mkdirSync(dir, { recursive: true })
    const name = basename(source)
    copyFileSync(source, join(dir, name))
    await ignoreLocally(cwd)
    return join(DIR, name)
  } catch (err) {
    console.error('[handoff] could not place the document', err)
    return null
  }
}

/** The checkout's own exclude file, so the brief is invisible to git without touching .gitignore. */
function ignoreLocally(cwd: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, timeout: 5000 }, (err, stdout) => {
      const rel = stdout.trim()
      if (err || !rel) return resolve()
      const file = rel.startsWith('/') ? rel : join(cwd, rel)
      try {
        mkdirSync(dirname(file), { recursive: true })
        const body = existsSync(file) ? readFileSync(file, 'utf8') : ''
        if (!body.includes('/.claude/handoff')) {
          appendFileSync(file, `${body && !body.endsWith('\n') ? '\n' : ''}# handed over by agent-fleet\n/.claude/handoff/\n`)
        }
      } catch {
        // an exclude that cannot be written only means a noisier status
      }
      resolve()
    })
  })
}
