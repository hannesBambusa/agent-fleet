import { execFile } from 'node:child_process'
import { constants, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ApplyPlan, MergePlan } from '../../shared/types'
import { baseOf, git, MAX_BUFFER, run, upstreamState, worktrees } from './exec'

// Operations that write: every one of them sits behind a button the user pressed, and each is
// preceded by a plan that says what it would do and refuses when that is unsafe.
export * from './read'
export * from './ship'

// letters from `git status --porcelain`: X is the index, Y is the working tree

// how this branch stands against the remote branch it tracks, which is what push cares about

/** the branch's own history, newest first */

/** Commits what is staged. Only ever from a button the user pressed, and never with -a. */

export async function commit(cwd: string, message: string): Promise<string> {
  const text = message.trim()
  if (!text) throw new Error('a commit needs a message')
  const staged = (await git(cwd, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
  if (!staged.length) throw new Error('nothing is staged')
  const out = await new Promise<string>((resolve, reject) => {
    const p = execFile('git', ['commit', '-F', '-'], { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const all = `${stdout}${stderr}`.trim()
      if (err) reject(new Error(all || err.message))
      else resolve(all)
    })
    p.stdin?.end(text)
  })
  return out.split('\n')[0] || `committed ${staged.length} file(s)`
}

export function stage(cwd: string, paths: string[]): Promise<string> {
  return git(cwd, ['add', '--', ...paths])
}

export function unstage(cwd: string, paths: string[]): Promise<string> {
  return git(cwd, ['restore', '--staged', '--', ...paths])
}

/** Every worktree of this repository, so the merge can run where the target branch is checked out. */

/**
 * What merging this branch would do, and every reason it should not run. Checked before anything is
 * touched, because a refused merge is cheap and a half-finished one is not.
 */
export async function mergePlan(cwd: string): Promise<MergePlan> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const into = (await baseOf(cwd, branch)) ?? ''
  const plan: MergePlan = { ok: false, reason: null, branch, into, commits: 0, files: 0, fastForward: false, at: null }
  if (!into) {
    plan.reason = 'no base branch to merge into'
    return plan
  }

  const dirty = (await git(cwd, ['status', '--porcelain', '-uno'])).trim()
  if (dirty) {
    plan.reason = 'this worktree has uncommitted changes; commit or discard them first'
    return plan
  }

  plan.commits = Number((await git(cwd, ['rev-list', '--count', `${into}..HEAD`])).trim()) || 0
  if (!plan.commits) {
    plan.reason = `nothing to merge; ${branch} adds no commits to ${into}`
    return plan
  }
  plan.files = (await git(cwd, ['diff', '--name-only', `${into}...HEAD`])).split('\n').filter(Boolean).length

  // the target branch lives in whichever checkout has it; that is where the merge must happen
  const wts = await worktrees(cwd)
  const host = wts.find((w) => w.branch === into)
  if (!host) {
    plan.reason = `${into} is not checked out in any worktree of this repository`
    return plan
  }
  plan.at = host.path

  const hostDirty = (await git(host.path, ['status', '--porcelain', '-uno'])).trim()
  if (hostDirty) {
    plan.reason = `${into} has uncommitted changes in ${host.path}; merging would mix them in`
    return plan
  }

  const mergeBase = (await git(cwd, ['merge-base', into, 'HEAD'])).trim()
  const intoHead = (await git(cwd, ['rev-parse', into])).trim()
  plan.fastForward = mergeBase === intoHead
  plan.ok = true
  return plan
}

/** Merges the agent's branch into its base. Only ever from a button the user pressed. */

export async function merge(cwd: string): Promise<string> {
  const plan = await mergePlan(cwd)
  if (!plan.ok || !plan.at) throw new Error(plan.reason ?? 'merge refused')
  try {
    const out = await git(plan.at, ['merge', '--no-edit', plan.branch])
    return out.trim() || `merged ${plan.branch} into ${plan.into}`
  } catch (err) {
    // leave nothing half-applied: back out and report which files disagreed
    const conflicts = await git(plan.at, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
    await git(plan.at, ['merge', '--abort']).catch(() => '')
    const list = conflicts.split('\n').filter(Boolean)
    if (list.length) throw new Error(`conflicts in ${list.length} file(s), merge aborted: ${list.slice(0, 5).join(', ')}`)
    throw err
  }
}

/**
 * Everything this worktree changed against its base, committed or not, as one patch. This is the
 * whole point of the "apply" path: a merge can only move commits, and an agent's most recent work
 * is usually still sitting in its working tree.
 */
async function fullPatch(cwd: string, base: string): Promise<string> {
  // `.claude/worktrees` holds the agents' own checkouts; carrying it across would record the
  // deletion or duplication of another agent's working directory as if it were project work
  return git(cwd, ['diff', '--binary', '--no-color', base, '--', '.', ':(exclude).claude/worktrees/**'])
}

/**
 * The agents' own checkouts, which the parent repository sees as plain untracked paths. Every list
 * of files that feeds the apply path has to drop them, and one rule doing it keeps the plan and the
 * copy that follows it judging the same set of files.
 */
function inWorktrees(path: string): boolean {
  return path === '.claude/worktrees' || path.startsWith('.claude/worktrees/')
}

async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '')
  return out.split('\0').filter(Boolean).filter((p) => !inWorktrees(p))
}

/**
 * Uncommitted paths in a checkout, untracked ones included, since an untracked file is exactly what
 * the apply path can destroy without leaving a copy anywhere.
 */
async function dirtyPaths(cwd: string): Promise<string[]> {
  // `-z` because the porcelain quotes any path with a space in it, and the plan compares these
  // against names cut out of a patch. The entry is never trimmed first: the status letters are
  // columns, so slice(3) is the path only while the two letters and their separator are still there.
  const entries = (await git(cwd, ['status', '--porcelain', '-uall', '-z'])).split('\0')
  const out: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    // a rename or copy is followed by its old path in the next NUL-separated field
    if (entry[0] === 'R' || entry[0] === 'C') i += 1
    // a nested repository stays a single directory entry even under -uall, hence the trailing slash
    const path = entry.slice(3).replace(/\/$/, '')
    if (!inWorktrees(path)) out.push(path)
  }
  return out
}

export async function applyPlan(cwd: string): Promise<ApplyPlan> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const base = (await baseOf(cwd, branch)) ?? ''
  const plan: ApplyPlan = {
    ok: false,
    reason: null,
    branch,
    into: base,
    files: 0,
    untracked: 0,
    at: null,
    dirtyTarget: 0,
    overlaps: []
  }
  if (!base) {
    plan.reason = 'no base branch to compare against'
    return plan
  }

  const host = (await worktrees(cwd)).find((w) => w.branch === base)
  if (!host) {
    plan.reason = `${base} is not checked out in any worktree of this repository`
    return plan
  }
  plan.at = host.path

  const patch = await fullPatch(cwd, base)
  const extras = await untrackedFiles(cwd)
  plan.files = patch.split('\n').filter((l) => l.startsWith('diff --git ')).length
  plan.untracked = extras.length
  if (!plan.files && !plan.untracked) {
    plan.reason = `nothing to apply; this worktree matches ${base}`
    return plan
  }

  // The target checkout usually has unrelated work in it, and applying alongside that is the normal
  // case. What is not safe is applying *over* it: a file the patch rewrites that also holds edits of
  // the user's own has no way back, since neither version is committed anywhere. Refuse only that.
  const dirty = await dirtyPaths(host.path)
  plan.dirtyTarget = dirty.length
  const touched = new Set(
    patch
      .split('\n')
      .filter((l) => l.startsWith('diff --git '))
      .map((l) => l.replace(/^diff --git a\/(.+?) b\/.*$/, '$1'))
  )
  // the untracked files are in no patch, so they have to be named here too or the copy that carries
  // them across is judged by nothing at all
  for (const rel of extras) touched.add(rel)
  plan.overlaps = dirty.filter((f) => touched.has(f))
  if (plan.overlaps.length) {
    plan.reason =
      `${plan.overlaps.length} file(s) are uncommitted in ${base} and this apply would write over ` +
      `them, with neither version committed: ${plan.overlaps.slice(0, 4).join(', ')}`
    return plan
  }

  if (patch.trim()) {
    // ask git whether the patch lands before touching anything
    const check = await new Promise<string | null>((resolve) => {
      const p = execFile('git', ['apply', '--3way', '--check', '-'], { cwd: host.path }, (err, _o, stderr) =>
        resolve(err ? stderr.trim() || 'patch does not apply' : null)
      )
      p.stdin?.end(patch)
    })
    if (check) {
      plan.reason = `these changes do not apply cleanly onto ${base}: ${check.split('\n')[0]}`
      return plan
    }
  }

  plan.ok = true
  return plan
}

/** Copies the worktree's changes into the base checkout as ordinary edits, staged by nothing. */

export async function applyChanges(cwd: string): Promise<string> {
  const plan = await applyPlan(cwd)
  if (!plan.ok || !plan.at) throw new Error(plan.reason ?? 'apply refused')
  const base = plan.into
  const patch = await fullPatch(cwd, base)

  if (patch.trim()) {
    await new Promise<void>((resolve, reject) => {
      const p = execFile('git', ['apply', '--3way', '-'], { cwd: plan.at! }, (err, _o, stderr) =>
        err ? reject(new Error(stderr.trim() || 'patch failed')) : resolve()
      )
      p.stdin?.end(patch)
    })
  }

  // `git apply --3way` leaves what it merged in the index. Copied changes are for reviewing, not
  // for committing blind, so they are put back into the working tree — and only the paths this
  // apply touched, leaving anything the user had already staged alone.
  const touched = patch
    .split('\n')
    .filter((l) => l.startsWith('diff --git '))
    .map((l) => l.replace(/^diff --git a\/(.*?) b\/.*$/, '$1'))
    .filter(Boolean)
  if (touched.length) await git(plan.at, ['restore', '--staged', '--', ...touched]).catch(() => '')

  // untracked files are in no diff, so they are copied across by hand
  const extras = await untrackedFiles(cwd)
  const copied: string[] = []
  const skipped: string[] = []
  for (const rel of extras) {
    const from = join(cwd, rel)
    const to = join(plan.at, rel)
    mkdirSync(dirname(to), { recursive: true })
    try {
      // COPYFILE_EXCL, never a plain copy: a file already standing here is the user's, the plan
      // refused every case where losing it is survivable, and an overwrite is the one mistake this
      // path cannot undo. Skipping and saying so beats a success message over a destroyed file.
      copyFileSync(from, to, constants.COPYFILE_EXCL)
      copied.push(rel)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      skipped.push(rel)
    }
  }

  const parts = [`applied ${plan.files} file(s) onto ${base}`]
  if (copied.length) parts.push(`${copied.length} new file(s) copied`)
  if (skipped.length) {
    parts.push(
      `${skipped.length} not copied, ${base} already has a file of that name and it was left ` +
        `untouched: ${skipped.slice(0, 4).join(', ')}`
    )
  }
  parts.push('left unstaged for review; nothing was staged or committed')
  return parts.join(' · ')
}

/**
 * The GitHub page for turning this branch into a pull request. Built from the remote URL, so it
 * works without the gh CLI, and GitHub itself answers the question the app cannot: does it merge.
 */
export async function pullRequestUrl(cwd: string): Promise<string | null> {
  const remote = (await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
  if (!remote) return null
  // git@github.com:owner/repo.git and https://github.com/owner/repo.git both reduce to owner/repo
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)
  if (!m) return null
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    .then((r) => r.trim().replace(/^[^/]+\//, ''))
    .catch(() => '')
  const head = upstream || branch
  const base = (await baseOf(cwd, branch)) ?? 'main'
  return `https://github.com/${m[1]}/compare/${base}...${encodeURIComponent(head)}?expand=1`
}

/**
 * Publish the agent's commits under a branch name of your choosing, without touching any checkout.
 * `HEAD:refs/heads/<name>` pushes the commits straight to a remote branch, so the local branch keeps
 * its generated name and the main working tree is never involved — it works while main is dirty.
 */
export async function pushAsBranch(cwd: string, name: string): Promise<string> {
  const clean = name.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._\/-]/g, '')
  if (!clean) throw new Error('give the branch a name')
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['push', '-u', 'origin', `HEAD:refs/heads/${clean}`],
      { cwd, timeout: 120000, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const text = `${stdout}${stderr}`.trim()
        if (err) reject(new Error(text || err.message))
        else resolve(text)
      }
    )
  })
  // git prints the pull-request link on the first push of a branch, which is exactly the next step
  const link = out.split('\n').find((l) => l.includes('http'))
  return `pushed to origin/${clean}${link ? ` · ${link.trim()}` : ' · open a pull request to merge it'}`
}

/**
 * Merge into the base branch and push it. This is what "I am done with this work" means: the agent's
 * branch is already on the remote, but the repository everyone else reads is the base branch.
 */
export async function publish(cwd: string): Promise<string> {
  const plan = await mergePlan(cwd)
  if (!plan.ok || !plan.at) throw new Error(plan.reason ?? 'publish refused')
  const merged = await merge(cwd)
  const pushed = await new Promise<string>((resolve, reject) => {
    execFile('git', ['push'], { cwd: plan.at!, timeout: 120000, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim()
      if (err) reject(new Error(`merged into ${plan.into}, but the push failed: ${out || err.message}`))
      else resolve(out)
    })
  })
  return `${merged} · pushed ${plan.into}${pushed ? ` · ${pushed.split('\n').pop()}` : ''}`
}

/** Pushes the current branch, creating the remote branch the first time. The user's call, never the app's. */

export async function push(cwd: string): Promise<string> {
  const { upstream } = await upstreamState(cwd)
  const args = upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120000, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim()
      if (err) reject(new Error(out || err.message))
      else resolve(out || 'pushed')
    })
  })
}

/** Runs git without throwing, so a ship step can report its own failure instead of unwinding a stack. */
