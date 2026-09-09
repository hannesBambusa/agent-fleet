import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApplyPlan,
  ShipDeploy,
  ShipEvent,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitFile,
  GitStatus,
  MergePlan,
  ShipEntry,
  ShipPlan,
  ShipResult
} from '../../shared/types'

const MAX_BUFFER = 8 * 1024 * 1024

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10000, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      // a diff that finds differences exits 1; that is a result, not a failure
      if (err && !stdout && stderr) return reject(new Error(stderr.trim() || err.message))
      resolve(stdout)
    })
  })
}

// letters from `git status --porcelain`: X is the index, Y is the working tree
function label(code: string): string {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflict'
    case '?':
      return 'untracked'
    default:
      return 'changed'
  }
}

/**
 * What this branch should be compared against, and merged into. It must be a *local* branch: a
 * remote-tracking ref like `origin/main` is checked out nowhere, so merging or applying onto it is
 * impossible. The remote's default tells us the name; the local branch of that name is the target.
 */
async function baseOf(cwd: string, branch: string): Promise<string | null> {
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
async function upstreamState(cwd: string): Promise<{ upstream: string | null; ahead: number; behind: number }> {
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    .then((r) => r.trim())
    .catch(() => '')
  if (!upstream) return { upstream: null, ahead: 0, behind: 0 }
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).catch(() => '')
  const [behind, ahead] = counts.trim().split(/\s+/).map((n) => Number(n) || 0)
  return { upstream, ahead: ahead ?? 0, behind: behind ?? 0 }
}

export async function status(cwd: string): Promise<GitStatus> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const out = await git(cwd, ['status', '--porcelain', '-uall', '-z'])
  const staged: GitFile[] = []
  const unstaged: GitFile[] = []

  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    let path = entry.slice(3)
    // a rename is followed by its old path in the next NUL-separated field
    if (x === 'R' || x === 'C') i += 1
    if (x === '?' && y === '?') {
      unstaged.push({ path, status: 'untracked', letter: '?', staged: false, committed: false })
      continue
    }
    if (x !== ' ' && x !== '?') staged.push({ path, status: label(x), letter: x, staged: true, committed: false })
    if (y !== ' ' && y !== '?') unstaged.push({ path, status: label(y), letter: y, staged: false, committed: false })
  }

  // work the agent already committed on its own branch is still "its changes" to a reader
  const committed: GitFile[] = []
  let base: string | null = null
  let ahead = 0
  try {
    base = await baseOf(cwd, branch)
    if (base) {
      ahead = Number((await git(cwd, ['rev-list', '--count', `${base}..HEAD`])).trim()) || 0
      if (ahead > 0) {
        const names = await git(cwd, ['diff', '--name-status', `${base}...HEAD`])
        for (const line of names.split('\n')) {
          const [code, ...rest] = line.split('\t')
          const path = rest[rest.length - 1]
          if (!code || !path) continue
          const letter = code[0]
          committed.push({ path, status: label(letter), letter, staged: false, committed: true })
        }
      }
    }
  } catch {
    // no base branch to compare against; committed stays empty
  }

  const up = await upstreamState(cwd)
  // with no upstream yet, every commit this branch added on top of its base is unpublished
  const range = up.upstream ? '@{upstream}..HEAD' : base ? `${base}..HEAD` : 'HEAD'
  const unpushedCommits = up.upstream || base ? await commits(cwd, range) : []
  const unpushed = up.upstream ? up.ahead : unpushedCommits.length

  const sort = (a: GitFile, b: GitFile): number => a.path.localeCompare(b.path)
  return {
    root,
    branch,
    base,
    upstream: up.upstream,
    unpushed,
    unpushedCommits,
    behind: up.behind,
    ahead,
    staged: staged.sort(sort),
    unstaged: unstaged.sort(sort),
    committed: committed.sort(sort)
  }
}

export async function diff(
  cwd: string,
  path: string,
  staged: boolean,
  untracked: boolean,
  base?: string,
  sha?: string
): Promise<string> {
  if (sha) return git(cwd, ['show', '--no-color', '--format=', sha, '--', path])
  if (base) return git(cwd, ['diff', '--no-color', `${base}...HEAD`, '--', path])
  if (untracked) {
    // /dev/null against the file renders a new file as one big addition
    return git(cwd, ['diff', '--no-index', '--', '/dev/null', path]).catch(() => '')
  }
  const args = ['diff', '--no-color']
  if (staged) args.push('--cached')
  args.push('--', path)
  return git(cwd, args)
}

const SEP = '\x1f'

async function commits(cwd: string, range: string, max = 25): Promise<GitCommit[]> {
  const fmt = ['%h', '%s', '%aI', '%an', '%D'].join(SEP)
  const out = await git(cwd, ['log', `--max-count=${max}`, `--format=${fmt}`, range]).catch(() => '')
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, at, author, refs] = line.split(SEP)
      return { sha, subject, at, author, refs: refs ? refs.split(', ').filter(Boolean) : [] }
    })
}

/** the branch's own history, newest first */
export function log(cwd: string, max = 120): Promise<GitCommit[]> {
  return commits(cwd, 'HEAD', max)
}

export async function commitDetail(cwd: string, sha: string): Promise<GitCommitDetail> {
  const fmt = ['%H', '%h', '%s', '%b', '%aI', '%an', '%ae', '%D'].join(SEP)
  const head = await git(cwd, ['show', '--no-patch', `--format=${fmt}`, sha])
  const [full, short, subject, body, at, author, email, refs] = head.split(SEP)
  const names = await git(cwd, ['show', '--no-color', '--name-status', '--format=', sha])
  const files: GitFile[] = names
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split('\t')
      const path = rest[rest.length - 1]
      return { path, status: label(code[0]), letter: code[0], staged: false, committed: true }
    })
  const stat = await git(cwd, ['show', '--shortstat', '--format=', sha]).catch(() => '')
  return {
    sha: full.trim(),
    short,
    subject,
    body: (body ?? '').trim(),
    at,
    author,
    email,
    refs: refs ? refs.trim().split(', ').filter(Boolean) : [],
    files,
    stat: stat.trim()
  }
}

export async function branches(cwd: string): Promise<GitBranch[]> {
  const fmt = [
    '%(refname:short)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(HEAD)',
    '%(committerdate:iso-strict)',
    '%(contents:subject)'
  ].join(SEP)
  const out = await git(cwd, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, track, head, at, subject] = line.split(SEP)
      return {
        name,
        upstream: upstream || null,
        ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
        current: head.trim() === '*',
        at,
        subject
      }
    })
}

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
async function worktrees(cwd: string): Promise<Array<{ path: string; branch: string | null }>> {
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

async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '')
  return out.split('\0').filter(Boolean).filter((p) => !p.startsWith('.claude/worktrees/'))
}

export async function applyPlan(cwd: string): Promise<ApplyPlan> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const base = (await baseOf(cwd, branch)) ?? ''
  const plan: ApplyPlan = { ok: false, reason: null, branch, into: base, files: 0, untracked: 0, at: null, dirtyTarget: 0 }
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

  plan.dirtyTarget = (await git(host.path, ['status', '--porcelain', '-uno'])).split('\n').filter(Boolean).length

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
  for (const rel of extras) {
    const from = join(cwd, rel)
    const to = join(plan.at, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }

  const parts = [`applied ${plan.files} file(s) onto ${base}`]
  if (extras.length) parts.push(`${extras.length} new file(s) copied`)
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
function run(cwd: string, args: string[], timeout = 15000): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      resolve({ ok: !err, text: `${stdout}${stderr}`.trim() })
    })
  })
}

/**
 * Uncommitted paths in a checkout, minus anything belonging to another worktree of the same
 * repository. `git status` reports a nested worktree as a plain untracked directory, which makes it
 * look stashable; it is not.
 */
async function hostChanges(host: string, wts: Array<{ path: string }>): Promise<string[]> {
  const root = (await git(host, ['rev-parse', '--show-toplevel'])).trim()
  const nested = wts
    .map((w) => w.path)
    .filter((p) => p !== root && p.startsWith(`${root}/`))
    .map((p) => p.slice(root.length + 1))
  const raw = (await git(host, ['status', '--porcelain', '-uall']))
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/\/$/, '').replace(/^"|"$/g, ''))
  return raw.filter((p) => !nested.some((n) => p === n || n.startsWith(`${p}/`) || p.startsWith(`${n}/`)))
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

/**
 * The whole road from "the agent is done" to "origin has it", inspected before anything moves.
 *
 * Every obstacle that normally derails this by hand is found here first: work still uncommitted on
 * either side, a base branch that has moved on the remote, files that would collide. Nothing in this
 * function writes: a refused ship costs a second, a half-finished one costs an evening.
 */
export async function shipPlan(cwd: string): Promise<ShipPlan> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const into = (await baseOf(cwd, branch)) ?? ''
  const plan: ShipPlan = {
    ok: false,
    branch,
    into,
    at: null,
    remote: null,
    commits: 0,
    files: 0,
    dirty: [],
    hostDirty: [],
    behind: 0,
    conflicts: [],
    steps: []
  }
  const block = (key: string, title: string, detail: string): ShipPlan => {
    plan.steps.push({ key, title, detail, state: 'block' })
    return plan
  }

  if (!into) return block('base', 'find the base branch', 'no local main or master to ship into')

  const wts = await worktrees(cwd)
  const host = wts.find((w) => w.branch === into)
  if (!host) return block('base', 'find the base branch', `${into} is not checked out in any worktree`)
  plan.at = host.path

  // 1. the agent's own uncommitted work — ship commits it rather than leaving it behind
  plan.dirty = (await git(cwd, ['status', '--porcelain', '-uall']))
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
  plan.steps.push(
    plan.dirty.length
      ? { key: 'commit', title: 'commit the agent\'s work', detail: `${plan.dirty.length} uncommitted file(s) in the worktree`, state: 'run' }
      : { key: 'commit', title: 'commit the agent\'s work', detail: 'worktree is clean', state: 'skip' }
  )

  plan.commits = Number((await git(cwd, ['rev-list', '--count', `${into}..HEAD`])).trim()) || 0
  plan.files = lines(await git(cwd, ['diff', '--name-only', `${into}...HEAD`])).length
  if (!plan.commits && !plan.dirty.length) return block('merge', 'merge into ' + into, `${branch} adds nothing to ${into}`)

  // 2. fetch before judging anything. Without this, "no conflicts" and "level with origin" are
  // answers about a stale ref, which is the exact failure this whole panel exists to prevent.
  await run(host.path, ['fetch', 'origin', into], 120000)
  plan.remote = (await run(host.path, ['rev-parse', '--verify', '--quiet', `origin/${into}`])).ok ? `origin/${into}` : null
  if (plan.remote) {
    plan.behind = Number((await run(host.path, ['rev-list', '--count', `${into}..origin/${into}`])).text.trim()) || 0
    plan.steps.push(
      plan.behind
        ? { key: 'update', title: `update ${into} from origin`, detail: `${plan.behind} new commit(s) on ${plan.remote}`, state: 'run' }
        : { key: 'update', title: `update ${into} from origin`, detail: `fetched · ${into} is level with origin`, state: 'skip' }
    )
  } else {
    plan.steps.push({ key: 'update', title: `update ${into} from origin`, detail: 'no remote branch yet', state: 'warn' })
  }

  // 3. the main checkout's own uncommitted files — set aside and put back, never merged over.
  // The agents' worktrees live inside the main checkout and show up as untracked directories there;
  // stashing one would carry off a live checkout, so they are excluded from everything below.
  plan.hostDirty = await hostChanges(host.path, wts)
  plan.steps.push(
    plan.hostDirty.length
      ? { key: 'stash', title: 'set aside local changes', detail: `${plan.hostDirty.length} uncommitted file(s) in ${into}, restored afterwards`, state: 'warn' }
      : { key: 'stash', title: 'set aside local changes', detail: `${into} is clean`, state: 'skip' }
    )

  // 4. would it collide? merge-tree answers in memory, touching no checkout and no index
  const target = plan.behind ? `origin/${into}` : into
  const tree = await run(cwd, ['merge-tree', '--write-tree', '--name-only', target, 'HEAD'])
  if (!tree.ok) {
    // the first line is the tree oid; the rest are the conflicting paths
    plan.conflicts = lines(tree.text).slice(1).filter((l) => !l.startsWith('CONFLICT') && !l.includes(' '))
  }
  plan.steps.push(
    plan.conflicts.length
      ? { key: 'conflicts', title: 'check for conflicts', detail: `${plan.conflicts.length} file(s) collide with ${target}`, state: 'block' }
      : { key: 'conflicts', title: 'check for conflicts', detail: `merges cleanly into ${target}`, state: 'skip' }
  )

  plan.steps.push({ key: 'merge', title: `merge into ${into}`, detail: `${plan.commits || 1} commit(s), ${plan.files} file(s)`, state: 'run' })
  plan.steps.push({
    key: 'push',
    title: `push ${into} to origin`,
    detail: plan.remote ? 'this is what a deploy builds' : 'no remote configured',
    state: plan.remote ? 'run' : 'block'
  })

  plan.ok = !plan.steps.some((s) => s.state === 'block')
  return plan
}

/**
 * What deploys off this branch, read from the repository rather than configured. A `heroku` remote
 * names the app outright; a Procfile without one means the app is wired to GitHub and builds on push.
 */
async function deployTarget(at: string): Promise<ShipDeploy | null> {
  const remote = (await run(at, ['remote', 'get-url', 'heroku'])).text.trim()
  const app = /git\.heroku\.com[:/](.+?)(?:\.git)?$/.exec(remote)?.[1]
  if (app) {
    return {
      name: app,
      detail: 'this repository has a heroku remote, so deploy it there when you are ready',
      url: `https://dashboard.heroku.com/apps/${app}`
    }
  }
  const proc = await run(at, ['ls-files', '--error-unmatch', 'Procfile'])
  if (proc.ok) {
    return {
      name: 'Heroku',
      detail: 'a Procfile is committed here, so an app connected to this branch starts building now',
      url: 'https://dashboard.heroku.com/apps'
    }
  }
  return null
}

/**
 * Runs the plan above, one step at a time, keeping the log the user reads afterwards.
 *
 * The invariant that makes this safe to press: anything set aside is put back, and a step that fails
 * stops the run and unwinds itself, so the tree is never left mid-merge. Only ever from a button.
 */
export async function ship(cwd: string, message: string, emit?: (e: ShipEvent) => void): Promise<ShipResult> {
  const log: ShipEntry[] = []
  const res: ShipResult = { ok: false, log, deploy: null, sha: null, url: null }
  // the plan itself fetches, which is slow enough to be worth showing as a step of its own
  emit?.({ key: 'plan', title: 'check the repository', done: false })
  let started = Date.now()
  const plan = await shipPlan(cwd)
  const begin = (key: string, title: string): void => {
    started = Date.now()
    emit?.({ key, title, done: false })
  }
  const step = (key: string, title: string, ok: boolean, text: string): boolean => {
    const ms = Date.now() - started
    log.push({ key, title, ok, text, ms })
    emit?.({ key, title, done: true, ok, text, ms })
    started = Date.now()
    return ok
  }
  if (!plan.ok || !plan.at) {
    const why = plan.steps.find((s) => s.state === 'block')
    step('plan', 'check the repository', false, why ? `${why.title}: ${why.detail}` : 'ship refused')
    return res
  }
  const at = plan.at
  step(
    'plan',
    'check the repository',
    true,
    [
      plan.commits ? `${plan.commits} commit(s)` : null,
      plan.dirty.length ? `${plan.dirty.length} uncommitted file(s)` : null
    ]
      .filter(Boolean)
      .join(' + ') + ` ready for ${plan.into}`
  )

  if (plan.dirty.length) {
    if (!message.trim()) {
      step('commit', 'commit the agent\'s work', false, 'the worktree has uncommitted files, so this commit needs a message')
      return res
    }
    begin('commit', `commit ${plan.dirty.length} file(s)`)
    const add = await run(cwd, ['add', '-A'])
    if (!add.ok) {
      step('commit', 'commit the agent\'s work', false, add.text)
      return res
    }
    const c = await run(cwd, ['commit', '-m', message.trim()])
    if (!step('commit', `commit ${plan.dirty.length} file(s)`, c.ok, c.text.split('\n')[0] || message.trim())) return res
  } else {
    step('commit', 'commit the agent\'s work', true, 'nothing to commit, worktree clean')
  }

  // set the main checkout's own work aside; from here every exit must put it back
  let stashed = false
  if (plan.hostDirty.length) {
    begin('stash', `set aside ${plan.hostDirty.length} local file(s)`)
    // explicit paths, never a bare `stash -u`: the worktrees under this checkout must stay put
    const s = await run(at, ['stash', 'push', '-u', '-m', 'agent-fleet ship', '--', ...plan.hostDirty])
    stashed = s.ok && !s.text.includes('No local changes')
    if (!step('stash', `set aside ${plan.hostDirty.length} local file(s)`, s.ok, s.ok ? 'stashed, restored at the end' : s.text)) return res
  }
  const restore = async (): Promise<void> => {
    if (!stashed) return
    begin('restore', 'restore local changes')
    const p = await run(at, ['stash', 'pop'])
    step('restore', 'restore local changes', p.ok, p.ok ? 'put back' : `left in the stash: ${p.text}`)
  }

  begin('update', `update ${plan.into} from origin`)
  if (plan.remote) await run(at, ['fetch', 'origin', plan.into], 120000)
  const behind = Number((await run(at, ['rev-list', '--count', `${plan.into}..origin/${plan.into}`])).text.trim()) || 0
  if (behind) {
    const ff = await run(at, ['merge', '--ff-only', `origin/${plan.into}`])
    if (!step('update', `update ${plan.into} from origin`, ff.ok, ff.ok ? `fast-forwarded ${behind} commit(s)` : ff.text)) {
      await restore()
      return res
    }
  } else {
    step('update', `update ${plan.into} from origin`, true, 'already level with origin')
  }

  begin('merge', `merge into ${plan.into}`)
  const m = await run(at, ['merge', '--no-edit', plan.branch], 60000)
  if (!m.ok) {
    const conflicts = lines((await run(at, ['diff', '--name-only', '--diff-filter=U'])).text)
    await run(at, ['merge', '--abort'])
    step('merge', `merge into ${plan.into}`, false, conflicts.length ? `conflicts, merge aborted: ${conflicts.slice(0, 6).join(', ')}` : m.text)
    await restore()
    return res
  }
  step('merge', `merge into ${plan.into}`, true, m.text.split('\n')[0] || `merged ${plan.branch}`)

  begin('push', `push ${plan.into} to origin`)
  const p = await run(at, ['push', 'origin', plan.into], 180000)
  if (!step('push', `push ${plan.into} to origin`, p.ok, p.ok ? p.text.split('\n').filter(Boolean).pop() || 'pushed' : p.text)) {
    await restore()
    return res
  }

  await restore()
  res.sha = (await run(at, ['rev-parse', '--short', 'HEAD'])).text.trim() || null
  const remote = (await run(at, ['remote', 'get-url', 'origin'])).text.trim()
  const gh = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)
  if (gh && res.sha) res.url = `https://github.com/${gh[1]}/commit/${res.sha}`
  res.deploy = await deployTarget(at)
  res.ok = log.every((e) => e.ok)
  return res
}
