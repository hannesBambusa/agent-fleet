import type { Session } from '../../../shared/types'

export const CARD_W = 232
export const CARD_H = 88
export const REPO_W = 168
export const REPO_H = 52
const COL_GAP = 72
const ROW_GAP = 18
const GROUP_GAP = 34
const PAD = 28

export interface RepoNode {
  key: string
  name: string
  path: string
  x: number
  y: number
  sessions: SessionNode[]
}
export interface SessionNode {
  s: Session
  x: number
  y: number
  /** subagents spawned by this session, whether or not they are currently drawn */
  childCount: number
  children: SessionNode[]
}
export interface Edge {
  from: { x: number; y: number }
  to: { x: number; y: number }
  id: string
  selected: boolean
}
export interface Graph {
  repos: RepoNode[]
  nodes: SessionNode[]
  edges: Edge[]
  width: number
  height: number
}

// order is by identity, never by activity: a card that moves while you are reading it is worse
// than a card in a slightly stale position
const byName = (a: [string, Session[]], b: [string, Session[]]): number =>
  a[1][0].repo.localeCompare(b[1][0].repo) || a[0].localeCompare(b[0])

// height a node needs including its subtree, so siblings never overlap
function blockHeight(n: SessionNode): number {
  if (!n.children.length) return CARD_H
  const kids = n.children.reduce((h, c) => h + blockHeight(c), 0) + (n.children.length - 1) * ROW_GAP
  return Math.max(CARD_H, kids)
}

// place a node vertically centred in its block, children stacked in the next column
function place(n: SessionNode, x: number, top: number, out: SessionNode[]): void {
  const h = blockHeight(n)
  n.x = x
  n.y = top + h / 2 - CARD_H / 2
  out.push(n)
  let y = top
  for (const c of n.children) {
    place(c, x + CARD_W + COL_GAP, y, out)
    y += blockHeight(c) + ROW_GAP
  }
}

const byStart = (a: Session, b: Session): number =>
  (a.firstEventAt ?? '').localeCompare(b.firstEventAt ?? '') || a.id.localeCompare(b.id)

// repo column → session column → subagent columns (one per depth). Deterministic, newest first.
export function buildGraph(sessions: Session[], expanded?: Set<string>): Graph {
  const roots = sessions.filter((s) => !s.parentId)
  const subs = sessions.filter((s) => s.parentId)
  const byParent = new Map<string, Session[]>()
  for (const s of subs) {
    const key = s.parentAgentId ?? s.parentId!
    byParent.set(key, [...(byParent.get(key) ?? []), s])
  }
  const build = (s: Session): SessionNode => {
    const kids = (byParent.get(s.id) ?? []).sort(byStart)
    const open = expanded ? expanded.has(s.id) : true
    return { s, x: 0, y: 0, childCount: kids.length, children: open ? kids.map(build) : [] }
  }

  const byRepo = new Map<string, Session[]>()
  for (const s of roots) byRepo.set(s.repoPath, [...(byRepo.get(s.repoPath) ?? []), s])
  const groups = [...byRepo.entries()].sort(byName)

  const nodes: SessionNode[] = []
  const edges: Edge[] = []
  const x1 = PAD + REPO_W + COL_GAP
  let y = PAD
  const repos: RepoNode[] = groups.map(([path, list]) => {
    const trees = list.slice().sort(byStart).map(build)
    const top = y
    for (const t of trees) {
      place(t, x1, y, nodes)
      y += blockHeight(t) + ROW_GAP
    }
    const h = y - ROW_GAP - top
    y += GROUP_GAP
    return { key: path, name: list[0].repo, path, x: PAD, y: top + h / 2 - REPO_H / 2, sessions: trees }
  })

  for (const r of repos) {
    for (const t of r.sessions) {
      edges.push({ id: `${r.key}→${t.s.id}`, from: { x: r.x + REPO_W, y: r.y + REPO_H / 2 }, to: { x: t.x, y: t.y + CARD_H / 2 }, selected: false })
    }
  }
  const walk = (n: SessionNode): void => {
    for (const c of n.children) {
      edges.push({ id: `${n.s.id}→${c.s.id}`, from: { x: n.x + CARD_W, y: n.y + CARD_H / 2 }, to: { x: c.x, y: c.y + CARD_H / 2 }, selected: false })
      walk(c)
    }
  }
  for (const r of repos) r.sessions.forEach(walk)

  const width = nodes.reduce((w, n) => Math.max(w, n.x + CARD_W), x1 + CARD_W) + PAD
  return { repos, nodes, edges, width, height: Math.max(y - GROUP_GAP + PAD, 200) }
}

// elbow path between two anchor points, stopping short of the arrowhead
export function edgePath(e: Edge): string {
  const mx = e.from.x + (e.to.x - e.from.x) / 2
  return `M ${e.from.x} ${e.from.y} H ${mx} V ${e.to.y} H ${e.to.x - 6}`
}
