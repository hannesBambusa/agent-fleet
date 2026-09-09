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
