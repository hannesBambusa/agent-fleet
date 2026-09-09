import type { GitCommit } from '../../../shared/types'

/**
 * Lane assignment for a commit graph, the same shape VS Code and gitk draw.
 *
 * One pass down the list, holding a set of open lanes. Each lane remembers the sha it is still
 * waiting for; a commit takes the lane that was waiting for it, or a free one if nothing was, and
 * then hands its parents back to the lanes: the first parent continues in the same lane, the rest
 * open or join lanes of their own, which is what makes a merge fan out.
 */

export interface Link {
  /** lane the line leaves from, at the top of the row */
  from: number
  /** lane it arrives in, at the bottom */
  to: number
  color: string
  /** a line that just passes through this row, drawn straight */
  straight: boolean
}

export interface Row {
  commit: GitCommit
  lane: number
  color: string
  links: Link[]
  /** a line comes down into this commit from the row above */
  up: boolean
  /** its first parent carries the same lane on downwards */
  down: boolean
}

// the validated categorical set the usage charts use, so lanes stay apart for colour-blind readers
const LANES = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#e0af68', '#4bb8c4']

export function laneColor(i: number): string {
  return LANES[i % LANES.length]
}

export function layout(commits: GitCommit[]): { rows: Row[]; width: number } {
  // lanes[i] is the sha lane i is waiting for, or null when the lane is free
  const lanes: (string | null)[] = []
  const rows: Row[] = []
  let width = 1

  const free = (): number => {
    const i = lanes.indexOf(null)
    if (i >= 0) return i
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    const before = [...lanes]
    let lane = lanes.indexOf(commit.sha)
    if (lane < 0) {
      lane = free()
      lanes[lane] = commit.sha
    }

    // every other lane waiting for this same commit merges into it here
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.sha) lanes[i] = null
    }

    const [first, ...rest] = commit.parents
    lanes[lane] = first ?? null
    for (const p of rest) {
      const existing = lanes.indexOf(p)
      if (existing >= 0) continue
      const target = free()
      lanes[target] = p
    }

    // a lane that emptied at the end of the list should not keep the graph wide
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    width = Math.max(width, before.length, lanes.length, lane + 1)

    const links: Link[] = []
    const seen = new Set<string>()
    const add = (from: number, to: number, color: string, straight: boolean): void => {
      const key = `${from}:${to}`
      if (seen.has(key)) return
      seen.add(key)
      links.push({ from, to, color, straight })
    }

    // lines arriving from above: this commit's own lane, the lanes merging into it, and every
    // unrelated lane that simply continues past this row
    for (let i = 0; i < before.length; i++) {
      if (before[i] === null) continue
      if (i === lane) continue
      if (before[i] === commit.sha) add(i, lane, laneColor(i), false)
      else if (lanes[i] === before[i]) add(i, i, laneColor(i), true)
      else if (lanes.indexOf(before[i]!) >= 0) add(i, lanes.indexOf(before[i]!), laneColor(i), false)
    }
    // lines leaving downward for parents that took a lane of their own
    for (const p of rest) {
      const target = lanes.indexOf(p)
      if (target >= 0 && target !== lane) add(lane, target, laneColor(target), false)
    }

    rows.push({
      commit,
      lane,
      color: laneColor(lane),
      links,
      up: before[lane] === commit.sha,
      down: lanes[lane] !== null && lanes[lane] !== undefined
    })
  }

  return { rows, width }
}

/** Refs worth showing beside a commit, ordered so the branch you are on reads first. */
export function refBadges(refs: string[]): Array<{ label: string; kind: 'head' | 'local' | 'remote' | 'tag' }> {
  return refs
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      if (r.startsWith('HEAD -> ')) return { label: r.slice(8), kind: 'head' as const }
      if (r === 'HEAD') return { label: 'HEAD', kind: 'head' as const }
      if (r.startsWith('tag: ')) return { label: r.slice(5), kind: 'tag' as const }
      if (r.includes('/')) return { label: r, kind: 'remote' as const }
      return { label: r, kind: 'local' as const }
    })
    .sort((a, b) => (a.kind === 'head' ? -1 : b.kind === 'head' ? 1 : 0))
}
