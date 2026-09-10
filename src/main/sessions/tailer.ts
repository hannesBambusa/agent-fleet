import { EventEmitter } from 'node:events'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Session, SessionState } from '../../shared/types'
import { applyLine } from './parse'
import { topicFor } from './topics'
import { labelFor } from './labels'
import { Liveness } from './liveness'

const PROJECTS = join(homedir(), '.claude', 'projects')
const POLL_MS = 600
const STALE_MS = 15 * 60 * 1000
const ENDED_MS = 24 * 60 * 60 * 1000
// an idle or ended claim stays true until something contradicts it
const HOOK_IDLE_MS = 10 * 60 * 1000
// a running claim is only about the moment it was made: without a fresh one, fall back to the log
const HOOK_RUN_MS = 45 * 1000
// files older than this are not parsed at all on startup
const HISTORY_MS = 3 * 24 * 60 * 60 * 1000
// a session this fresh is live even if the process scan has not caught up
const GRACE_MS = 90 * 1000
// a subagent writes to its log only while it works, so recent output means it is still running
// A subagent between two tool calls is thinking, not waiting for anyone, so it is given far longer
// than a minute of quiet before it is called idle. A minute was shorter than a single search.
const SUBAGENT_ACTIVE_MS = 3 * 60 * 1000
// a session that just finished a tool call is thinking about the next one, not idle
const BETWEEN_TOOLS_MS = 25 * 1000
// after the last words of an answer, a session is waiting for its human again
const ANSWER_SETTLE_MS = 12 * 1000
// the longest a single tool call is assumed to still be running when nothing has followed it
const OPEN_TOOL_MS = 10 * 60 * 1000

interface Tracked {
  session: Session
  offset: number
  rest: string
}

interface SubagentMeta {
  agentType?: string
  description?: string
  parentAgentId?: string
  spawnDepth?: number
}

export class Tailer extends EventEmitter {
  // directory listings, kept until the directory's own mtime moves
  private dirs = new Map<string, { mtime: number; names: string[] }>()
  private files = new Map<string, Tracked>()
  private timer: NodeJS.Timeout | null = null
  private live = new Liveness()
  // sessions this app launched and still holds a pty for: never guessed about
  private owned = new Set<string>()

  start(): void {
    this.live.start()
    this.scan()
    this.timer = setInterval(() => this.scan(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.live.stop()
  }

  setOwned(ids: string[]): void {
    this.owned = new Set(ids)
  }

  list(): Session[] {
    return [...this.files.values()].map((t) => t.session)
  }

  get(id: string): Session | undefined {
    for (const t of this.files.values()) if (t.session.id === id) return t.session
    return undefined
  }

  /**
   * The name and note shown for a session. A label someone typed wins outright; failing that, the
   * topic file, then whatever Claude Code called it.
   */
  private retitle(s: Session): void {
    const label = labelFor(s.id)
    s.note = label?.note || null
    s.topic = label?.name || topicFor(s.id, s.cwd)
  }

  /** Re-read a session's label and tell the app, after someone has just changed it. */
  relabel(sessionId: string): Session | undefined {
    const s = this.get(sessionId)
    if (!s) return undefined
    this.retitle(s)
    this.emit('update', s)
    return s
  }

  /** Every transcript belonging to a session: its own, and its subagents'. */
  filesOf(sessionId: string): string[] {
    const out: string[] = []
    for (const [file, t] of this.files) {
      if (t.session.id === sessionId || t.session.parentId === sessionId) out.push(file)
    }
    return out
  }

  /**
   * Drop a session the app has just deleted from disk.
   *
   * Without this the tailer keeps the parsed copy in memory and the card stays on screen until a
   * restart: nothing in the poll notices a file that stopped existing, because a missing file is
   * indistinguishable from one that has not been written yet.
   */
  forget(sessionId: string): void {
    for (const [file, t] of [...this.files]) {
      if (t.session.id !== sessionId && t.session.parentId !== sessionId) continue
      this.files.delete(file)
      this.emit('gone', t.session.id)
    }
  }

  applyHook(id: string, state: SessionState, at: string, tool?: string, clearTool = false): void {
    const s = this.get(id)
    if (!s) return
    s.hookState = { state, at, tool }
    if (clearTool) s.currentTool = null
    else if (tool) s.currentTool = tool
    this.recompute(s)
    this.emit('update', s)
  }

  /**
   * Lists a directory, but only when it has actually changed.
   *
   * This runs on the main thread every 600 ms and walks every project the user has ever opened, so
   * its cost grows with history rather than with live agents. A directory's mtime moves when an entry
   * is added or removed, which is the only thing this listing is for: the files themselves are read
   * by track(), which does its own stat.
   */
  private listing(dir: string): string[] {
    let mtime: number
    try {
      mtime = statSync(dir).mtimeMs
    } catch {
      this.dirs.delete(dir)
      return []
    }
    const seen = this.dirs.get(dir)
    if (seen && seen.mtime === mtime) return seen.names
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      names = []
    }
    this.dirs.set(dir, { mtime, names })
    return names
  }

  private scan(): void {
    const dirs = this.listing(PROJECTS)
    if (!dirs.length) return
    const now = Date.now()
    const changed = new Set<Session>()
    for (const dir of dirs) {
      const projectDir = join(PROJECTS, dir)
      const names = this.listing(projectDir).filter((n) => n.endsWith('.jsonl'))
      for (const name of names) {
        const sessionId = basename(name, '.jsonl')
        this.track(join(projectDir, name), dir, sessionId, null, now, changed)
        // subagents live in <project>/<sessionId>/subagents/agent-<id>.jsonl
        const subDir = join(projectDir, sessionId, 'subagents')
        const subs = this.listing(subDir).filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'))
        for (const sub of subs) this.track(join(subDir, sub), dir, sessionId, sub.slice('agent-'.length, -'.jsonl'.length), now, changed)
      }
    }
    this.markDead()
    for (const t of this.files.values()) {
      const before = t.session.state
      this.recompute(t.session)
      if (t.session.state !== before) changed.add(t.session)
    }
    for (const s of changed) {
      if (!s.parentId) this.retitle(s)
      this.emit('update', s)
    }
  }

  private track(file: string, dir: string, sessionId: string, agentId: string | null, now: number, changed: Set<Session>): void {
    let size: number
    let mtime: number
    try {
      const st = statSync(file)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      return
    }
    let t = this.files.get(file)
    if (!t) {
      if (now - mtime > HISTORY_MS) return
      t = { session: this.blank(file, dir, sessionId, agentId), offset: 0, rest: '' }
      this.files.set(file, t)
    }
    if (agentId && !t.session.agentType) this.readMeta(t.session, file)
    if (size > t.offset) {
      this.readFrom(t, file, size)
      changed.add(t.session)
    } else if (size < t.offset) {
      const fresh = { session: this.blank(file, dir, sessionId, agentId), offset: 0, rest: '' }
      this.files.set(file, fresh)
      if (agentId) this.readMeta(fresh.session, file)
      this.readFrom(fresh, file, size)
      changed.add(fresh.session)
    }
  }

  private readMeta(s: Session, file: string): void {
    const metaFile = file.replace(/\.jsonl$/, '.meta.json')
    if (!existsSync(metaFile)) return
    try {
      const m = JSON.parse(readFileSync(metaFile, 'utf8')) as SubagentMeta
      s.agentType = m.agentType ?? 'agent'
      s.topic = m.description ?? s.topic
      s.parentAgentId = m.parentAgentId ?? null
      s.depth = m.spawnDepth ?? 1
    } catch {
      // meta not fully written yet; retried next scan
    }
  }

  private readFrom(t: Tracked, file: string, size: number): void {
    const fd = openSync(file, 'r')
    try {
      const len = size - t.offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, t.offset)
      t.offset = size
      const text = t.rest + buf.toString('utf8')
      const lines = text.split('\n')
      t.rest = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) applyLine(t.session, line)
    } finally {
      closeSync(fd)
    }
  }

  private blank(file: string, dir: string, sessionId: string, agentId: string | null): Session {
    const cwd = '/' + dir.replace(/^-/, '').replace(/-/g, '/')
    return {
      id: agentId ?? sessionId,
      origin: agentId ? 'subagent' : undefined,
      parentId: agentId ? sessionId : null,
      parentAgentId: null,
      agentType: null,
      depth: agentId ? 1 : 0,
      file,
      cwd,
      repoPath: cwd,
      repo: basename(cwd),
      worktree: null,
      branch: null,
      topic: null,
      model: null,
      version: null,
      lastCommand: null,
      lastCommandAt: null,
      commands: [],
      turnEnded: false,
      note: null,
      lastPrompt: null,
      lastPromptAt: null,
      lastEventAt: null,
      firstEventAt: null,
      turns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      context: 0,
      currentTool: null,
      state: 'idle',
      closed: false,
      hookState: null,
      transcript: []
    }
  }

  /**
   * Only the N most recently active sessions in a directory can be the N live `claude` processes
   * there. Everything older in that directory belonged to a terminal that has since been closed.
   */
  private markDead(): void {
    if (this.live.unknown) return
    const groups = new Map<string, Session[]>()
    for (const t of this.files.values()) {
      const s = t.session
      if (s.parentId) continue
      s.repoPath = worktreeOf(s.cwd)?.root ?? s.cwd
      groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])
    }
    const now = Date.now()
    const closedRoots = new Set<string>()
    for (const [cwd, list] of groups) {
      const alive = this.live.countFor(cwd)
      // No process at all where a session was writing minutes ago is a scan that missed it, not a
      // directory that emptied. `closed` is the one verdict nothing downstream can overturn, so on
      // an answer this suspect the whole directory is left alone, as an unknown scan already is.
      const blind = alive === 0 && list.some((s) => s.lastEventAt !== null && now - Date.parse(s.lastEventAt) < STALE_MS)
      list.sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''))
      list.forEach((s, i) => {
        const fresh = s.lastEventAt ? now - Date.parse(s.lastEventAt) < GRACE_MS : false
        s.closed = !blind && i >= alive && !fresh && !this.owned.has(s.id)
        if (s.closed) closedRoots.add(s.id)
      })
    }
    // a subagent cannot outlive the session that spawned it
    for (const t of this.files.values()) {
      const s = t.session
      if (s.parentId) s.closed = closedRoots.has(s.parentId)
    }
  }

  private recompute(s: Session): void {
    const wt = worktreeOf(s.cwd)
    s.repoPath = wt ? wt.root : s.cwd
    s.worktree = wt ? wt.name : null
    s.repo = basename(s.repoPath)
    const verdict = stateOf(s, Date.now())
    if (verdict.clearTool) s.currentTool = null
    s.state = verdict.state
  }
}

/**
 * What state a session is in, as a pure function of the session and the clock.
 *
 * Split out of recompute() so it can be tested without a filesystem: every wrong-looking card this
 * project has hit was a wrong branch in here, and the shape of the inputs (a timestamp, a hook claim,
 * the last transcript item) is exactly what a fixture can express. See test/state.test.mjs.
 */
export function stateOf(s: Session, now: number): { state: SessionState; clearTool: boolean } {
  const last = s.lastEventAt ? Date.parse(s.lastEventAt) : 0
  const age = now - last
  if (s.closed) return { state: 'ended', clearTool: false }
  if (age > ENDED_MS) return { state: 'ended', clearTool: false }

  // A finished turn is a fact the transcript states outright, so it outranks anything inferred from
  // how recently a line was written. A hook claim only wins if it arrived after that last line —
  // which is what a new prompt looks like, a second before the transcript catches up.
  const hookIsNewer = s.hookState ? Date.parse(s.hookState.at) > Date.parse(s.lastEventAt ?? '') : false
  if (s.turnEnded && !hookIsNewer) {
    return { state: age > STALE_MS ? 'stale' : 'idle', clearTool: true }
  }

  if (s.hookState) {
    const said = now - Date.parse(s.hookState.at)
    const h = s.hookState.state
    if (h === 'ended' && said < HOOK_IDLE_MS) return { state: 'ended', clearTool: false }
    if (h === 'idle' && said < HOOK_IDLE_MS) {
      return { state: age > STALE_MS ? 'stale' : 'idle', clearTool: false }
    }
    // a permission prompt stays true until a tool hook contradicts it, so it keeps idle's window:
    // on the short one it expired mid-prompt and the transcript's open tool call reported running,
    // telling the user an agent is busy when it is in fact blocked on them
    if (h === 'waiting' && said < HOOK_IDLE_MS) return { state: 'waiting', clearTool: false }
    // a stale "running" claim is worse than no claim: it pins a finished agent green forever
    if (h === 'running' && said < HOOK_RUN_MS) return { state: 'running', clearTool: false }
  }

  if (age > STALE_MS) return { state: 'stale', clearTool: false }
  // a subagent has no user to wait for: between two tool calls it is thinking, not idle
  if (s.parentId) {
    // The same evidence a root session is judged on: an open tool call is work, whatever its age.
    // Judging a subagent purely on how recently it wrote made one vanish mid-search — a long call
    // writes nothing while it runs, and the fleet only shows subagents that are working.
    if (working(s, now)) return { state: 'running', clearTool: false }
    return { state: age < SUBAGENT_ACTIVE_MS ? 'running' : 'idle', clearTool: false }
  }
  if (working(s, now)) return { state: 'running', clearTool: false }
  // nothing is running, so nothing is "currently" a tool either
  return { state: 'idle', clearTool: true }
}

function working(s: Session, now: number): boolean {
  const last = s.transcript[s.transcript.length - 1]
  if (!last) return false
  // Age against the last thing that was *said*, not the session's newest line: resuming a session
  // writes bookkeeping lines with fresh timestamps, and judging against those makes a conversation
  // that ended hours ago look like it is mid-thought.
  const age = now - Date.parse(last.ts)
  // An open tool call is the strongest sign of work, but only while it could still be running. A
  // session killed mid-call leaves one open forever, which is what made every agent look busy
  // after a restart.
  if (last.kind === 'tool') {
    // The generous window is for a genuinely slow call, where nothing else has been written since.
    // If the session has written other lines after it, the call almost certainly finished and its
    // result simply was not in a shape the parser recognised, so decay like any other pause.
    const wroteSince = s.lastEventAt ? Date.parse(s.lastEventAt) - Date.parse(last.ts) : 0
    return age < (wroteSince > 5000 ? BETWEEN_TOOLS_MS : OPEN_TOOL_MS)
  }
  if (last.kind === 'result') return age < BETWEEN_TOOLS_MS
  if (last.kind === 'prompt' || last.kind === 'command') return age < BETWEEN_TOOLS_MS
  if (last.kind === 'text') return age < ANSWER_SETTLE_MS
  return false
}

function worktreeOf(cwd: string): { root: string; name: string } | null {
  const parent = dirname(cwd)
  if (basename(parent) !== 'worktrees' || basename(dirname(parent)) !== '.claude') return null
  return { root: dirname(dirname(parent)), name: basename(cwd) }
}
