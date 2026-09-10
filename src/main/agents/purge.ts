import { execFile } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Agent, PurgePlan, PurgeResult } from '../../shared/types'

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })
    )
  })
}

/**
 * What removing an agent for good would actually delete.
 *
 * "Remove" used to mean the app forgetting its own record, which left the conversation on disk and
 * the worktree on the filesystem: the card came back as a terminal session, and the checkout stayed
 * forever. Deleting all of it is the honest meaning, but it is not reversible, so everything is
 * counted first and nothing is deleted until it has been shown.
 */
export async function purgePlan(a: Agent, files: string[]): Promise<PurgePlan> {
  const transcripts = files.map((path) => {
    let bytes = 0
    try {
      bytes = statSync(path).size
    } catch {
      bytes = 0
    }
    return { path, bytes }
  })

  const dir = a.cwd && a.cwd !== a.repoPath ? a.cwd : null
  if (!dir) return { agentId: a.id, sessionId: a.sessionId, transcripts, worktree: null }

  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || null
  const dirty = (await git(dir, ['status', '--porcelain', '-uall'])).out.split('\n').filter(Boolean).length
  // commits that exist nowhere else: the only thing here that cannot be got back
  const unpushed = Number(
    (await git(dir, ['rev-list', '--count', '--branches=main', '--branches=master', '--not', 'HEAD'])).out.trim()
  )
  const ahead = Number((await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).out.trim()) || 0

  return {
    agentId: a.id,
    sessionId: a.sessionId,
    transcripts,
    worktree: { path: dir, name: basename(dir), branch, dirty, unpushed: ahead || unpushed || 0 }
  }
}

export async function purge(
  a: Agent,
  files: string[],
  opts: { worktree: boolean; branch: boolean; transcript: boolean }
): Promise<PurgeResult> {
  const done: string[] = []
  const failed: string[] = []

  if (opts.transcript) {
    for (const f of files) {
      try {
        // a session's subagents live in a directory named after it, beside its own file
        rmSync(f, { force: true })
        rmSync(f.replace(/\.jsonl$/, ''), { recursive: true, force: true })
        done.push(`deleted ${basename(f)}`)
      } catch (err) {
        failed.push(`${basename(f)}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const dir = a.cwd && a.cwd !== a.repoPath ? a.cwd : null
  if (opts.worktree && dir) {
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()
    // --force because a worktree with uncommitted files is exactly the case being cleaned up
    const removed = await git(a.repoPath, ['worktree', 'remove', '--force', dir])
    if (removed.ok) done.push(`removed the worktree ${basename(dir)}`)
    else failed.push(`worktree: ${removed.out.split('\n')[0]}`)

    if (opts.branch && branch && removed.ok) {
      const gone = await git(a.repoPath, ['branch', '-D', branch])
      if (gone.ok) done.push(`deleted the branch ${branch}`)
      else failed.push(`branch: ${gone.out.split('\n')[0]}`)
    }
  }

  return { done, failed }
}
