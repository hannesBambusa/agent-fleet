import { execFile } from 'node:child_process'
import type { ShipDeploy, ShipEntry, ShipEvent, ShipPlan, ShipResult } from '../../shared/types'
import { baseOf, git, lines, MAX_BUFFER, run, worktrees } from './exec'

// The one path from "the agent is done" to "origin has it": inspect everything first, then run it
// step by step, reporting each one as it goes.

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
