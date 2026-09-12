import type { GitStatus, MergePlan } from '../../../shared/types'

/**
 * One station on the way out of a worktree.
 *
 * Work moves left to right: edited, staged, committed on the agent's branch, merged into the main
 * checkout, pushed to the remote. What a station holds is work that has got that far and no further,
 * so the rightmost station holding anything is the answer to "where is my work".
 */
export interface Stage {
  key: 'changed' | 'staged' | 'committed' | 'merged' | 'pushed'
  label: string
  /** what is sitting here: files for the first two, commits after that */
  count: number
  unit: 'file' | 'commit'
  /** holding work · clear · this is as far as it gets until something is fixed */
  state: 'holding' | 'clear' | 'blocked'
  /** the checkout this station lives in, because half of them are not the agent's */
  where: 'worktree' | 'main' | 'remote'
}

export interface Next {
  /** what to do, in the imperative, naming the counts */
  text: string
  /** the same thing short enough for a button, and explicit about how far it reaches */
  button: string
  action: 'stage' | 'commit' | 'merge' | 'mergeAside' | null
  /** why the obvious next step cannot happen */
  blocked: string | null
  /** true when nothing is left to move */
  done: boolean
}

/**
 * Where the work has got to.
 *
 * `host` is the main checkout's own status, which is the half a worktree cannot see: whether the
 * branch has landed there, and whether that checkout has pushed. Without it the pane can only ever
 * answer half the question, which is what makes a worktree feel like it is eating work.
 */
function allStations(wt: GitStatus | null, host: GitStatus | null, plan: MergePlan | null): Stage[] {
  const merged = plan?.merged ?? false
  // commits that exist on the agent's branch and not yet in the branch it came from
  const ahead = wt?.ahead ?? 0
  const toMerge = merged ? 0 : (plan?.commits ?? ahead)
  // the main checkout is the authority on what it still owes the remote; without it, the worktree's
  // own count is the closest thing available
  const unpushed = host ? host.unpushed : (wt?.unpushed ?? 0)
  // Inside a worktree the journey ends at the local main: what the remote has is the main checkout's
  // business, and pushing is done from there. Showing it here only invites pushing from the wrong
  // place. Outside one, there is no main to merge into and the remote is the whole question.
  const stations: Stage[] = [
    {
      key: 'changed',
      label: 'changed',
      count: wt?.unstaged.length ?? 0,
      unit: 'file',
      state: (wt?.unstaged.length ?? 0) > 0 ? 'holding' : 'clear',
      where: 'worktree'
    },
    {
      key: 'staged',
      label: 'staged',
      count: wt?.staged.length ?? 0,
      unit: 'file',
      state: (wt?.staged.length ?? 0) > 0 ? 'holding' : 'clear',
      where: 'worktree'
    },
    {
      key: 'committed',
      label: 'committed here',
      count: merged ? 0 : ahead,
      unit: 'commit',
      state: merged || ahead === 0 ? 'clear' : 'holding',
      where: 'worktree'
    },
    {
      key: 'merged',
      label: 'in main',
      count: toMerge,
      unit: 'commit',
      // a plan that refuses is the one thing a count cannot express: the work is stuck here
      state: toMerge === 0 ? 'clear' : plan && !plan.ok ? 'blocked' : 'holding',
      where: 'main'
    },
    {
      key: 'pushed',
      label: 'on origin',
      count: unpushed,
      unit: 'commit',
      state: unpushed > 0 ? 'holding' : 'clear',
      where: 'remote'
    }
  ]
  return stations
}

/** The stations worth drawing here. */
export function stagesOf(
  wt: GitStatus | null,
  host: GitStatus | null,
  plan: MergePlan | null,
  worktree = false
): Stage[] {
  return allStations(wt, host, plan).filter((s) => (worktree ? s.key !== 'pushed' : s.key !== 'merged'))
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

/** The one thing to do next, which is whatever the leftmost station holding work needs. */
export function nextOf(
  wt: GitStatus | null,
  host: GitStatus | null,
  plan: MergePlan | null,
  worktree = false
): Next {
  const all = allStations(wt, host, plan)
  const find = (key: Stage['key']): Stage => all.find((s) => s.key === key)!
  const changed = find('changed')
  const staged = find('staged')
  const committed = find('committed')
  const merged = find('merged')
  const pushed = find('pushed')
  if (changed.count > 0) {
    return {
      text: `stage ${plural(changed.count, 'changed file')} in this worktree`,
      button: 'stage all',
      action: 'stage',
      blocked: null,
      done: false
    }
  }
  if (staged.count > 0) {
    return {
      text: `commit ${plural(staged.count, 'staged file')} on this agent's branch`,
      button: 'commit here',
      action: 'commit',
      blocked: null,
      done: false
    }
  }
  if (committed.count > 0 || merged.count > 0) {
    const into = plan?.into ?? 'the main branch'
    // The base checkout having its own open files is the one refusal with a safe way through: set
    // them aside, merge, put them back. Offered rather than done silently, because it touches a
    // checkout the user is not looking at.
    if (plan && !plan.ok && plan.hostDirty.length) {
      return {
        text: `merge ${plural(merged.count || committed.count, 'commit')} into ${into}, around its ${plural(plan.hostDirty.length, 'open file')}`,
        button: `merge → ${into} (local)`,
        action: 'mergeAside',
        blocked: null,
        done: false
      }
    }
    if (plan && !plan.ok) {
      return {
        text: `merge into ${into}`,
        button: 'merge blocked',
        action: null,
        blocked: plan.reason ?? 'the merge cannot run',
        done: false
      }
    }
    // Said in full because the distinction is the one that costs people a deploy: this moves commits
    // between two checkouts on this machine and touches no remote, so nothing builds from it.
    return {
      text: `merge ${plural(merged.count || committed.count, 'commit')} into ${into} — local only, nothing is pushed`,
      button: `merge → ${into} (local)`,
      action: 'merge',
      blocked: null,
      done: false
    }
  }
  // the remote is not this checkout's business; the main checkout reports it and pushes it
  if (pushed.count > 0 && !worktree) {
    const remote = host?.upstream ?? wt?.upstream ?? 'the remote'
    // Deliberately no button. Pushing is what reaches the build, and it belongs to the person, run
    // from the main checkout rather than from inside an agent's worktree.
    return {
      text: `${plural(pushed.count, 'commit')} in ${host?.branch ?? 'the main branch'} waiting to be pushed to ${remote} — push that yourself, outside the worktree`,
      button: '',
      action: null,
      blocked: null,
      done: false
    }
  }
  return {
    text: worktree
      ? `nothing to move: this worktree's work is in ${plan?.into ?? wt?.base ?? 'the main branch'}`
      : 'nothing to move: this work is merged and pushed',
    button: '',
    action: null,
    blocked: null,
    done: true
  }
}

/** Things about the main checkout worth saying out loud before anything is merged into it. */
export function hostNotes(host: GitStatus | null, plan: MergePlan | null): string[] {
  const notes: string[] = []
  if (!host) return notes
  const dirty = host.staged.length + host.unstaged.length
  // Only what a merge would land in the middle of. What the main checkout owes its remote is real,
  // but it is not this worktree's problem and naming it here invites pushing from inside one.
  if (dirty > 0) notes.push(`${plural(dirty, 'uncommitted file')} in the main checkout`)
  if (host.behind > 0) notes.push(`${plural(host.behind, 'commit')} behind its remote`)
  return notes
}

export interface Incoming {
  count: number
  base: string
  /** a merge into a stale branch is the usual source of conflicts, so say it before the merge */
  text: string
  /** the update runs a merge, and a merge onto uncommitted work leaves a mess */
  blocked: string | null
}

/** Work that landed in the base branch after this worktree was cut, and is missing from it. */
export function incomingOf(wt: GitStatus | null): Incoming | null {
  if (!wt || wt.behindBase <= 0) return null
  const base = wt.base ?? 'the main branch'
  const dirty = wt.staged.length + wt.unstaged.length
  return {
    count: wt.behindBase,
    base,
    text: `${base} has ${wt.behindBase} commit${wt.behindBase === 1 ? '' : 's'} this worktree does not`,
    blocked: dirty > 0 ? `commit the ${dirty} open file${dirty === 1 ? '' : 's'} here first` : null
  }
}
