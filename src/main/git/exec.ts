import { execFile } from 'node:child_process'

export const MAX_BUFFER = 8 * 1024 * 1024

/**
 * Runs git and resolves with stdout.
 *
 * Deliberately lenient: a diff that finds differences exits 1, and that is a result rather than a
 * failure. The cost of that leniency is that a command failing with nothing on stderr also resolves,
 * so an existence check must ask for a value and judge the output, never rely on rejection.
 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10000, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err && !stdout && stderr) return reject(new Error(stderr.trim() || err.message))
      resolve(stdout)
    })
  })
}

/** Runs git without throwing, so a caller can report a step's own failure instead of unwinding. */
export function run(cwd: string, args: string[], timeout = 15000): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: MAX_BUFFER }, (_e, stdout, stderr) => {
      resolve({ ok: !_e, text: `${stdout}${stderr}`.trim() })
    })
  })
}

/**
 * Whether git can work in this directory at all.
 *
 * A session's cwd is wherever the user happened to be, so having no repository is an ordinary
 * answer rather than a failure. Asked once at the top of each query, it also keeps the handful of
 * git calls behind one query from each rediscovering the same thing as a thrown error.
 *
 * `run` rather than `git`, because this is the one question where "git said no" and "git could not
 * run" must not be flattened together: only the first is an answer. Judging the exit code alone
 * would misread a repository whose rev-parse failed for some other reason.
 */
export async function isRepo(cwd: string): Promise<boolean> {
  const { ok, text } = await run(cwd, ['rev-parse', '--is-inside-work-tree'], 5000)
  if (ok) return text.trim() === 'true'
  // Only the parenthetical form means git walked up to the root and found nothing. The bare
  // "not a git repository: <path>" is a .git that points somewhere gone, which is how an agent
  // worktree breaks when its parent repository moves, and that has to be reported, not hidden.
  if (text.includes('not a git repository (or any of the parent directories)')) return false
  throw new Error(text || `git could not run in ${cwd}`)
}

export function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

/**
 * What this branch should be compared against, and merged into. It must be a *local* branch: a
 * remote-tracking ref like `origin/main` is checked out nowhere, so merging or applying onto it is
 * impossible. The remote's default tells us the name; the local branch of that name is the target.
 */
export async function baseOf(cwd: string, branch: string): Promise<string | null> {
  const candidates: string[] = []
  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
    .then((r) => r.trim())
    .catch(() => '')
  // origin/main -> main. With no origin/HEAD set git fails and echoes the argument back, so the
  // stripped name would be the literal "HEAD", which is no branch at all — drop that case.
  const named = head.includes('/') ? head.replace(/^[^/]+\//, '') : ''
  if (named && named !== 'HEAD') candidates.push(named)
  candidates.push('main', 'master')

  for (const name of candidates) {
    if (!name || name === branch) continue
    // `show-ref --quiet` says nothing on either channel when the ref is missing, and git() only
    // rejects on stderr, so a failed check read as a success and handed back a branch that exists
    // nowhere. Ask for the sha instead and judge on whether one came back.
    const sha = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).catch(() => '')
    if (sha.trim()) return name
  }
  return null
}

// how this branch stands against the remote branch it tracks, which is what push cares about
export async function upstreamState(cwd: string): Promise<{ upstream: string | null; ahead: number; behind: number }> {
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    .then((r) => r.trim())
    .catch(() => '')
  if (!upstream) return { upstream: null, ahead: 0, behind: 0 }
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).catch(() => '')
  const [behind, ahead] = counts.trim().split(/\s+/).map((n) => Number(n) || 0)
  return { upstream, ahead: ahead ?? 0, behind: behind ?? 0 }
}

/** Every worktree of this repository, so the merge can run where the target branch is checked out. */
export async function worktrees(cwd: string): Promise<Array<{ path: string; branch: string | null }>> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']).catch(() => '')
  const list: Array<{ path: string; branch: string | null }> = []
  let path = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9)
    else if (line.startsWith('branch ')) list.push({ path, branch: line.slice(7).replace('refs/heads/', '') })
    else if (line === '' && path) {
      if (!list.some((w) => w.path === path)) list.push({ path, branch: null })
      path = ''
    }
  }
  return list
}
