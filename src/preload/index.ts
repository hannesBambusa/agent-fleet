import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  Agent,
  AttentionItem,
  AttentionSettings,
  CatalogItem,
  BrowserState,
  BrowserTab,
  ConsoleEntry,
  DevProject,
  DevServer,
  DirEntry,
  FileContents,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  ApplyPlan,
  MergePlan,
  GitStatus,
  ShipEvent,
  ShipPlan,
  ShipResult,
  HookEvent,
  HookStatus,
  LaunchRequest,
  McpServer,
  PurgePlan,
  PurgeResult,
  Repo,
  SeedItem,
  SeedPlan,
  Session,
  SessionLabel,
  UsageSnapshot
} from '../shared/types'
function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const h = (_: unknown, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

/**
 * The whole surface the renderer is allowed to touch, grouped by what it is for.
 *
 * It was one flat list of sixty-odd functions, which read as a wall and grew in a straight line.
 * Same calls, same channels; only the shape changed, so `api.git.status(...)` says where a call
 * belongs and what else lives beside it.
 */
const api = {
  // a constant the renderer needs to expand a ~ in a path an agent wrote
  home: homedir(),
  usage: (): Promise<UsageSnapshot> => ipcRenderer.invoke('usage:read'),

  // every Claude Code session on the machine, watched
  sessions: {
    listSessions: (): Promise<Session[]> => ipcRenderer.invoke('sessions:list'),
    onSessionUpdate: (cb: (s: Session) => void) => on<[Session]>('sessions:update', cb),
    // a session whose transcript the app has just deleted, so the card can go at once
    onSessionGone: (cb: (id: string) => void) => on<[string]>('sessions:gone', cb),
    // a name and a description someone typed, which beat anything the app can derive
    label: (sessionId: string): Promise<SessionLabel | null> => ipcRenderer.invoke('sessions:label', sessionId),
    setLabel: (sessionId: string, label: SessionLabel): Promise<SessionLabel | null> =>
      ipcRenderer.invoke('sessions:setLabel', sessionId, label)
  },

  // the local receiver and the settings it installs itself into
  hooks: {
    onHookEvent: (cb: (e: HookEvent) => void) => on<[HookEvent]>('hooks:event', cb),
    hookStatus: (): Promise<HookStatus> => ipcRenderer.invoke('hooks:status'),
    installHooks: (): Promise<HookStatus> => ipcRenderer.invoke('hooks:install'),
    uninstallHooks: (): Promise<HookStatus> => ipcRenderer.invoke('hooks:uninstall')
  },

  // opening a path or a link in whatever the system uses for it
  shell: {
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:open', path),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:external', url)
  },

  // what needs a person: approvals to give, agents that finished
  attention: {
    list: (): Promise<AttentionItem[]> => ipcRenderer.invoke('attention:list'),
    prefs: (): Promise<AttentionSettings> => ipcRenderer.invoke('attention:prefs'),
    setPrefs: (p: Partial<AttentionSettings>): Promise<AttentionSettings> =>
      ipcRenderer.invoke('attention:setPrefs', p),
    dismiss: (id: string): Promise<void> => ipcRenderer.invoke('attention:dismiss', id),
    seen: (sessionId: string): Promise<void> => ipcRenderer.invoke('attention:seen', sessionId),
    clear: (): Promise<void> => ipcRenderer.invoke('attention:clear'),
    watching: (sessionId: string | null): void => ipcRenderer.send('attention:watching', sessionId),
    onUpdate: (cb: (items: AttentionItem[]) => void) => on<[AttentionItem[]]>('attention:update', cb),
    onOpen: (cb: (sessionId: string) => void) => on<[string]>('attention:open', cb)
  },

  // dev servers: what this project runs, what is already running, starting and stopping one
  dev: {
    project: (dir: string): Promise<DevProject | null> => ipcRenderer.invoke('dev:project', dir),
    servers: (repoPath: string): Promise<DevServer[]> => ipcRenderer.invoke('dev:servers', repoPath),
    stop: (pgid: number): Promise<{ ok: boolean; error: string | null }> => ipcRenderer.invoke('dev:stop', pgid),
    /** a port nothing is listening on, so two agents on one repo do not fight over one */
    freePort: (from?: number): Promise<number> => ipcRenderer.invoke('dev:freePort', from),
    /** the project's own dev command, told to listen on that port */
    onPort: (dir: string, port: number): Promise<string | null> => ipcRenderer.invoke('dev:onPort', dir, port),
    start: (id: string, cwd: string, command: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('dev:start', id, cwd, command, cols, rows)
  },

  // the repositories the app knows about
  repos: {
    listRepos: (): Promise<Repo[]> => ipcRenderer.invoke('repos:list'),
    upsertRepo: (r: Repo): Promise<Repo> => ipcRenderer.invoke('repos:upsert', r),
    removeRepo: (path: string): Promise<void> => ipcRenderer.invoke('repos:remove', path),
    pickRepo: (): Promise<Repo | null> => ipcRenderer.invoke('repos:pick')
  },

  // sessions this app launched, and their ptys
  agents: {
    listAgents: (): Promise<Agent[]> => ipcRenderer.invoke('agents:list'),
    launchAgent: (req: LaunchRequest, cols: number, rows: number): Promise<Agent> =>
    ipcRenderer.invoke('agents:launch', req, cols, rows),
    resumeAgent: (id: string, cols: number, rows: number): Promise<Agent | undefined> =>
    ipcRenderer.invoke('agents:resume', id, cols, rows),
    stopAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:stop', id),
    removeAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:remove', id),
    onUpdate: (cb: (a: Agent) => void) => on<[Agent]>('agents:update', cb),
    onRemoved: (cb: (id: string) => void) => on<[string]>('agents:removed', cb),
    // what removing this agent for good would delete, and doing it
    purgePlan: (id: string): Promise<PurgePlan | null> => ipcRenderer.invoke('agents:purgePlan', id),
    purge: (id: string, opts: { worktree: boolean; branch: boolean; transcript: boolean }): Promise<PurgeResult> =>
      ipcRenderer.invoke('agents:purge', id, opts)
  },

  // the terminal behind an agent
  pty: {
    history: (id: string): Promise<string> => ipcRenderer.invoke('pty:history', id),
    // a shell of your own in a given directory; opening one that is already running is a no-op
    open: (id: string, cwd: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('pty:open', id, cwd, cols, rows),
    close: (id: string): Promise<void> => ipcRenderer.invoke('pty:close', id),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
    onData: (cb: (id: string, data: string) => void) => on<[string, string]>('pty:data', cb)
  },

  // status, diffs, the commit graph, and the writes behind each button
  git: {
    status: (cwd: string): Promise<GitStatus | null> => ipcRenderer.invoke('git:status', cwd),
    push: (cwd: string): Promise<string> => ipcRenderer.invoke('git:push', cwd),
    graph: (cwd: string, max?: number): Promise<GitCommit[]> => ipcRenderer.invoke('git:graph', cwd, max),
    log: (cwd: string): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', cwd),
    mergePlan: (cwd: string): Promise<MergePlan | null> => ipcRenderer.invoke('git:mergePlan', cwd),
    /** uncommitted counts for many checkouts at once, for the fleet cards */
    dirty: (cwds: string[]): Promise<Record<string, { changed: number; staged: number }>> =>
      ipcRenderer.invoke('git:dirty', cwds),
    merge: (cwd: string): Promise<string> => ipcRenderer.invoke('git:merge', cwd),
    /** the same merge, with the base checkout's uncommitted work stashed and put back */
    mergeAside: (cwd: string): Promise<string> => ipcRenderer.invoke('git:mergeAside', cwd),
    /** the other direction: the base branch's newer commits, merged into this worktree */
    update: (cwd: string): Promise<string> => ipcRenderer.invoke('git:update', cwd),
    publish: (cwd: string): Promise<string> => ipcRenderer.invoke('git:publish', cwd),
    shipPlan: (cwd: string): Promise<ShipPlan> => ipcRenderer.invoke('git:shipPlan', cwd),
    ship: (cwd: string, message: string): Promise<ShipResult> => ipcRenderer.invoke('git:ship', cwd, message),
    prUrl: (cwd: string): Promise<string | null> => ipcRenderer.invoke('git:prUrl', cwd),
    pushBranch: (cwd: string, name: string): Promise<string> => ipcRenderer.invoke('git:pushBranch', cwd, name),
    applyPlan: (cwd: string): Promise<ApplyPlan | null> => ipcRenderer.invoke('git:applyPlan', cwd),
    apply: (cwd: string): Promise<string> => ipcRenderer.invoke('git:apply', cwd),
    commit: (cwd: string, sha: string): Promise<GitCommitDetail> => ipcRenderer.invoke('git:commit', cwd, sha),
    branches: (cwd: string): Promise<GitBranch[]> => ipcRenderer.invoke('git:branches', cwd),
    commitStaged: (cwd: string, message: string): Promise<string> => ipcRenderer.invoke('git:commitStaged', cwd, message),
    stage: (cwd: string, paths: string[]): Promise<string> => ipcRenderer.invoke('git:stage', cwd, paths),
    unstage: (cwd: string, paths: string[]): Promise<string> => ipcRenderer.invoke('git:unstage', cwd, paths),
    diff: (cwd: string, path: string, staged: boolean, untracked: boolean, base?: string, sha?: string): Promise<string> =>
    ipcRenderer.invoke('git:diff', cwd, path, staged, untracked, base, sha),
    onShipEvent: (cb: (e: ShipEvent) => void) => on<[ShipEvent]>('git:shipEvent', cb)
  },

  // images an agent can read, and the file browser
  files: {
    saveImage: (bytes: Uint8Array, mime: string): Promise<string> => ipcRenderer.invoke('files:saveImage', bytes, mime),
    pickImage: (): Promise<string | null> => ipcRenderer.invoke('files:pickImage'),
    imageThumb: (path: string): Promise<string | null> => ipcRenderer.invoke('files:thumb', path),
    listDir: (path: string): Promise<DirEntry[]> => ipcRenderer.invoke('files:list', path),
    readFile: (path: string): Promise<FileContents> => ipcRenderer.invoke('files:read', path)
  },

  // each agent's own Chromium pane
  browser: {
    layout: (agentId: string | null, bounds: { x: number; y: number; width: number; height: number } | null): void =>
    ipcRenderer.send('browser:layout', agentId, bounds),
    state: (agentId: string): Promise<BrowserState | null> => ipcRenderer.invoke('browser:state', agentId),
    console: (agentId: string): Promise<ConsoleEntry[]> => ipcRenderer.invoke('browser:console', agentId),
    devtools: (agentId: string): Promise<boolean> => ipcRenderer.invoke('browser:devtools', agentId),
    tabs: (agentId: string): Promise<{ tabs: BrowserTab[]; active: number }> =>
      ipcRenderer.invoke('browser:tabs', agentId),
    newTab: (agentId: string, url?: string): Promise<number> => ipcRenderer.invoke('browser:newTab', agentId, url),
    selectTab: (agentId: string, index: number): Promise<void> => ipcRenderer.invoke('browser:selectTab', agentId, index),
    closeTab: (agentId: string, index: number): Promise<void> => ipcRenderer.invoke('browser:closeTab', agentId, index),
    devtoolsOpen: (agentId: string): Promise<boolean> => ipcRenderer.invoke('browser:devtoolsOpen', agentId),
    clearConsole: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:clearConsole', agentId),
    navigate: (agentId: string, url: string): Promise<void> => ipcRenderer.invoke('browser:navigate', agentId, url),
    back: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:back', agentId),
    forward: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:forward', agentId),
    reload: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:reload', agentId),
    shot: (agentId: string): Promise<string> => ipcRenderer.invoke('browser:shot', agentId),
    onUpdate: (cb: (id: string, st: BrowserState) => void) => on<[string, BrowserState]>('browser:update', cb),
    onActivity: (cb: (id: string) => void) => on<[string]>('browser:activity', cb)
  },

  // what Claude Code can do here: skills, commands, agents, MCP
  catalog: {
    items: (): Promise<CatalogItem[]> => ipcRenderer.invoke('catalog:list'),
    mcpServers: (): Promise<McpServer[]> => ipcRenderer.invoke('catalog:mcp')
  },

  // carrying ignored config into a fresh worktree
  seed: {
    seedPlan: (repoPath: string, worktree: string): Promise<SeedPlan> => ipcRenderer.invoke('seed:plan', repoPath, worktree),
    seedApply: (repoPath: string, worktree: string, items: SeedItem[]): Promise<{ done: string[]; failed: string[] }> =>
    ipcRenderer.invoke('seed:apply', repoPath, worktree, items)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('api', api)
