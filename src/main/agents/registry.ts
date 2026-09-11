import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { execFile } from 'node:child_process'
import type { Agent, AgentStatus, LaunchRequest } from '../../shared/types'
import type { PtyManager } from '../pty/manager'
import { BROWSER_PORT, BROWSER_SECRET } from '../browser/server'
import { seedAuto } from '../git/seed'
import { placeHandoff } from '../files/handoff'

const FILE = (): string => join(app.getPath('userData'), 'agents.json')
// Somewhere to work when the task is not about a repository at all: a question, a scratch script, a
// bit of research. Under ~/.claude so it sits with the app's other state and is easy to find.
const SCRATCH = (): string => join(homedir(), '.claude', 'agent-fleet', 'scratch')
const SCRIPTS = (): string => join(app.getPath('userData'), 'launch')

/** tmux session name for a detached agent; short and unambiguous */
export function tmuxName(agentId: string): string {
  return `af-${agentId.slice(0, 8)}`
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Claude Code names its transcripts after a UUID. Anything else in that directory was not written by
// it, so it is never adopted as a session id, quoted or not.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A name that is safe to use as a directory. Free text arrives here from the launch dialog, and it
 * ends up as a path segment under `.claude/worktrees`, where `..` would escape the repository.
 */
function safeName(raw: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return clean || 'agent'
}

// agents have the Claude in Chrome extension available too; without this they reach for it and open
// a window outside the app, which the user cannot see in the browser pane
const BROWSER_PROMPT = [
  'You are running inside agent-fleet and have your own embedded browser pane,',
  'visible to the user next to this session.',
  'For anything web-related use the MCP tools named browser_navigate, browser_read_page,',
  'browser_click, browser_type, browser_press, browser_scroll, browser_screenshot,',
  'browser_get_url, browser_back, browser_read_console and browser_read_network.',
  'Prefer them over claude-in-chrome or any other browser tool: only these are visible to the user.'
].join(' ')

// inline MCP config pointing this agent at its own browser pane; merged with the user's own servers
function browserMcpConfig(agentId: string): string {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'browser-mcp', 'server.mjs')
    : join(app.getAppPath(), 'resources', 'browser-mcp', 'server.mjs')
  return JSON.stringify({
    mcpServers: {
      browser: {
        command: 'node',
        args: [script],
        env: {
          AGENT_FLEET_AGENT: agentId,
          AGENT_FLEET_BROWSER_PORT: String(BROWSER_PORT),
          AGENT_FLEET_BROWSER_SECRET: BROWSER_SECRET
        }
      }
    }
  })
}

/**
 * Does this transcript belong to this agent?
 *
 * The one definition of that question. It used to be answered independently wherever it came up —
 * once when adopting an unclaimed session, once when resuming the newest one — with rules that were
 * close but not identical, which is how an agent ended up showing twice or resuming a conversation
 * that was not its own. Matching on the agent's *own* worktree rather than any worktree of the repo
 * also stops two agents in one repository claiming each other's sessions.
 */
export function belongsTo(a: Agent, s: { cwd: string; parentId?: string | null }): boolean {
  if (s.parentId) return false
  // once the agent's home is known it is the whole answer; anything else is a different session
  if (a.cwd) return s.cwd === a.cwd
  if (s.cwd === a.repoPath) return true
  return a.worktree && s.cwd === join(a.repoPath, '.claude', 'worktrees', a.name)
}

export class AgentRegistry extends EventEmitter {
  private agents = new Map<string, Agent>()
  private wasLive = new Set<string>()
  // agents this app has actually spawned a pty for, so a not-yet-started one is never called dead
  private spawned = new Set<string>()

  constructor(private ptys: PtyManager) {
    super()
    try {
      const list = JSON.parse(readFileSync(FILE(), 'utf8')) as Agent[]
      for (const a of list) {
        // the repo was deleted or moved: the agent can never be resumed, so do not keep listing it
        if (!existsSync(a.repoPath)) continue
        if (a.status !== 'exited' || a.interrupted) this.wasLive.add(a.id)
        this.agents.set(a.id, { ...a, status: 'exited' })
      }
      this.save()
    } catch {
      // first run
    }
    ptys.on('exit', (id: string, code: number) => {
      const a = this.agents.get(id)
      if (!a) return
      a.status = 'exited'
      a.exitCode = code
      this.save()
      this.emit('update', a)
    })
  }

  list(): Agent[] {
    // An agent whose pty is gone is not "starting" or "live", whatever the last event claimed. Only
    // ones this app actually spawned count: `launch` saves the record before spawning, and saving
    // walks this list, so judging every agent here declared each new one dead a moment after birth.
    for (const a of this.agents.values()) {
      // a detached agent lives in tmux, so a missing pty only means nobody is watching it
      if (a.detached) continue
      if (a.status !== 'exited' && this.spawned.has(a.id) && !this.ptys.alive(a.id)) a.status = 'exited'
    }
    return [...this.agents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  launch(req: LaunchRequest, cols: number, rows: number): Agent {
    // no repository chosen: give it a folder of its own rather than dropping it in a home directory
    if (!req.repoPath) {
      const dir = join(SCRATCH(), new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
      mkdirSync(dir, { recursive: true })
      req = { ...req, repoPath: dir, worktree: false }
    }
    const sessionId = req.resumeSessionId ?? randomUUID()
    // the typed name becomes a directory under .claude/worktrees, so it is slugged like the fallback
    const titled = !!req.name.trim()
    const wanted = safeName(req.name || slugFrom(req.prompt))
    // Claude Code refuses to create a worktree whose directory already exists, and an abandoned one
    // from an earlier run keeps its name, so the launch died on the spot with nothing on screen.
    const name = req.worktree ? freeWorktreeName(req.repoPath, wanted) : wanted
    const a: Agent = {
      id: randomUUID(),
      sessionId,
      repoPath: req.repoPath,
      repoName: basename(req.repoPath),
      cwd: null,
      name,
      prompt: req.prompt,
      worktree: req.worktree,
      titled,
      handoff: req.handoff,
      browser: req.browser,
      chat: req.chat,
      detached: req.detached,
      status: 'starting',
      exitCode: null,
      createdAt: new Date().toISOString()
    }
    this.agents.set(a.id, a)
    this.save()
    this.spawn(a, req.resumeSessionId ? 'resume' : 'new', cols, rows)
    this.emit('update', a)
    return a
  }

  resume(id: string, cols: number, rows: number): Agent | undefined {
    const a = this.agents.get(id)
    if (!a || this.ptys.alive(id)) return a
    a.status = 'starting'
    a.exitCode = null
    a.interrupted = false
    this.wasLive.delete(id)
    // no cwd recorded means Claude never wrote a transcript: nothing to resume, start it over
    this.spawn(a, a.cwd ? 'resume' : 'new', cols, rows)
    this.emit('update', a)
    return a
  }

  stop(id: string): void {
    const a = this.agents.get(id)
    // detaching a tmux client would leave the session running; stop means stop
    if (a?.detached) this.killTmux(id)
    this.ptys.kill(id)
  }

  private killTmux(id: string): void {
    execFile('tmux', ['kill-session', '-t', tmuxName(id)], () => undefined)
  }

  /** which detached agents still have a tmux session, so the app can tell live from gone */
  syncDetached(alive: Set<string>): void {
    for (const a of this.agents.values()) {
      if (!a.detached) continue
      const up = alive.has(tmuxName(a.id))
      const next: AgentStatus = up ? (a.status === 'starting' ? 'starting' : 'live') : 'exited'
      if (a.status !== next) {
        a.status = next
        this.emit('update', a)
      }
    }
  }

  remove(id: string): void {
    if (this.agents.get(id)?.detached) this.killTmux(id)
    this.ptys.kill(id)
    this.agents.delete(id)
    this.save()
    this.emit('removed', id)
  }

  /**
   * Claude Code hands a resumed session a fresh id when the original is still running, so the id
   * the app asked for never appears on disk and the agent ends up on screen twice: one card with
   * the terminal, one with the transcript. Pointing the agent at the session that actually exists
   * puts them back together.
   */
  rebind(id: string, sessionId: string, cwd: string): void {
    const a = this.agents.get(id)
    if (!a || a.sessionId === sessionId) return
    if (!UUID.test(sessionId)) {
      console.error('[agents] refusing to adopt a session id that is not a uuid:', sessionId)
      return
    }
    a.sessionId = sessionId
    a.cwd = cwd
    a.status = 'live'
    this.save()
    this.emit('update', a)
  }

  markLive(id: string, cwd: string): void {
    const a = this.agents.get(id)
    if (!a) return
    let changed = false
    if (a.cwd !== cwd) {
      a.cwd = cwd
      changed = true
    }
    if (a.status === 'starting') {
      a.status = 'live'
      changed = true
    }
    if (changed) {
      this.save()
      this.emit('update', a)
    }
  }

  // called right before the app kills every pty on quit
  markInterrupted(): void {
    // a detached agent is not interrupted by quitting; it keeps running without us
    for (const a of this.agents.values()) if (a.status !== 'exited' && !a.detached) a.interrupted = true
    this.save()
  }

  // agents that were alive when the app last quit; resumed on startup
  interrupted(): Agent[] {
    return this.list().filter((a) => a.status === 'exited' && this.wasLive.has(a.id))
  }

  private spawn(a: Agent, mode: 'new' | 'resume', cols: number, rows: number): void {
    const args: string[] = []
    if (a.browser) {
      args.push('--mcp-config', shellQuote(browserMcpConfig(a.id)))
      args.push('--append-system-prompt', shellQuote(BROWSER_PROMPT))
    }
    // Every argument on this line goes through `zsh -lc`. The session id is usually a UUID we
    // generated, but rebind() takes it from a filename under ~/.claude/projects, which any process on
    // the machine can write to, so it is untrusted input like any other.
    if (mode === 'resume') args.push('--resume', shellQuote(a.sessionId))
    else {
      args.push('--session-id', shellQuote(a.sessionId))
      // Only a name the user chose is worth forcing. Left alone, Claude Code titles the session from
      // the work itself ("Participant widget campaign status filter"), and passing the generated
      // worktree directory name overwrote that with `agent-2`.
      if (a.titled) args.push('--name', shellQuote(a.name))
      if (a.worktree) args.push('--worktree', shellQuote(a.name))
      if (a.prompt) args.push(shellQuote(a.prompt))
    }
    this.spawned.add(a.id)
    const claude = `claude ${args.join(' ')}`
    const cwd = mode === 'resume' && a.cwd ? a.cwd : a.repoPath

    // A detached agent runs inside tmux: the app's terminal is only a client, so closing the app
    // detaches instead of killing, and `new-session -A` reattaches to whatever is still alive.
    let command = claude
    if (a.detached) {
      mkdirSync(SCRIPTS(), { recursive: true })
      const script = join(SCRIPTS(), `${a.id}.sh`)
      writeFileSync(script, `#!/bin/bash\ncd ${shellQuote(cwd)}\nexec ${claude}\n`)
      chmodSync(script, 0o755)
      command = `tmux new-session -A -s ${tmuxName(a.id)} -x ${cols} -y ${rows} ${shellQuote(script)}`
    }

    this.ptys.spawn(a.id, { cwd, cols, rows, command, env: { AGENT_FLEET_AGENT: a.id } })
    if (a.worktree && mode === 'new') void this.seedWhenReady(a)
    // without a worktree the agent works in the repository itself, which exists already
    else if (a.handoff && mode === 'new') void placeHandoff(a.repoPath, a.handoff)
  }

  /**
   * A worktree is a fresh checkout: everything git ignores is missing from it, `.env` included, and
   * the agent discovers that on its first command. Claude Code creates the directory itself, a second
   * or two after launch, so this waits for it to appear and then carries the config across.
   */
  private async seedWhenReady(a: Agent): Promise<void> {
    const dir = join(a.repoPath, '.claude', 'worktrees', a.name)
    for (let i = 0; i < 120; i++) {
      if (!this.agents.has(a.id)) return
      if (existsSync(dir)) {
        // the directory appears before the checkout is finished, so let it settle
        await new Promise((r) => setTimeout(r, 1500))
        if (a.handoff) await placeHandoff(dir, a.handoff)
        try {
          const done = await seedAuto(a.repoPath, dir)
          if (done.length) {
            a.seeded = done
            this.save()
            this.emit('update', a)
          }
        } catch (err) {
          console.error('[agents] seed failed', err)
        }
        return
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  private save(): void {
    try {
      writeFileSync(FILE(), JSON.stringify(this.list(), null, 2))
    } catch (err) {
      console.error('[agents] save failed', err)
    }
  }
}

/** the first unused worktree name in this repo: agent, then agent-2, agent-3 … */
function freeWorktreeName(repoPath: string, wanted: string): string {
  const dir = (n: string): string => join(repoPath, '.claude', 'worktrees', n)
  if (!existsSync(dir(wanted))) return wanted
  for (let i = 2; i < 50; i++) {
    if (!existsSync(dir(`${wanted}-${i}`))) return `${wanted}-${i}`
  }
  return `${wanted}-${Date.now()}`
}

function slugFrom(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
}
