import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  Agent,
  CatalogItem,
  BrowserState,
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
  Repo,
  SeedItem,
  SeedPlan,
  Session,
  UsageSnapshot
} from '../shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const h = (_: unknown, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api = {
  listSessions: (): Promise<Session[]> => ipcRenderer.invoke('sessions:list'),
  onSessionUpdate: (cb: (s: Session) => void) => on<[Session]>('sessions:update', cb),
  onHookEvent: (cb: (e: HookEvent) => void) => on<[HookEvent]>('hooks:event', cb),

  hookStatus: (): Promise<HookStatus> => ipcRenderer.invoke('hooks:status'),
  installHooks: (): Promise<HookStatus> => ipcRenderer.invoke('hooks:install'),
  uninstallHooks: (): Promise<HookStatus> => ipcRenderer.invoke('hooks:uninstall'),

  catalog: (): Promise<CatalogItem[]> => ipcRenderer.invoke('catalog:list'),
  mcpServers: (): Promise<McpServer[]> => ipcRenderer.invoke('catalog:mcp'),
  listRepos: (): Promise<Repo[]> => ipcRenderer.invoke('repos:list'),
  upsertRepo: (r: Repo): Promise<Repo> => ipcRenderer.invoke('repos:upsert', r),
  removeRepo: (path: string): Promise<void> => ipcRenderer.invoke('repos:remove', path),
  pickRepo: (): Promise<Repo | null> => ipcRenderer.invoke('repos:pick'),

  listAgents: (): Promise<Agent[]> => ipcRenderer.invoke('agents:list'),
  launchAgent: (req: LaunchRequest, cols: number, rows: number): Promise<Agent> =>
    ipcRenderer.invoke('agents:launch', req, cols, rows),
  resumeAgent: (id: string, cols: number, rows: number): Promise<Agent | undefined> =>
    ipcRenderer.invoke('agents:resume', id, cols, rows),
  stopAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:stop', id),
  removeAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:remove', id),
  onAgentUpdate: (cb: (a: Agent) => void) => on<[Agent]>('agents:update', cb),
  onAgentRemoved: (cb: (id: string) => void) => on<[string]>('agents:removed', cb),

  ptyHistory: (id: string): Promise<string> => ipcRenderer.invoke('pty:history', id),
  ptyWrite: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
  onPtyData: (cb: (id: string, data: string) => void) => on<[string, string]>('pty:data', cb),

  saveImage: (bytes: Uint8Array, mime: string): Promise<string> => ipcRenderer.invoke('files:saveImage', bytes, mime),
  pickImage: (): Promise<string | null> => ipcRenderer.invoke('files:pickImage'),
  imageThumb: (path: string): Promise<string | null> => ipcRenderer.invoke('files:thumb', path),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:open', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:external', url),

  browserLayout: (agentId: string | null, bounds: { x: number; y: number; width: number; height: number } | null): void =>
    ipcRenderer.send('browser:layout', agentId, bounds),
  browserShot: (agentId: string): Promise<string> => ipcRenderer.invoke('browser:shot', agentId),
  browserState: (agentId: string): Promise<BrowserState | null> => ipcRenderer.invoke('browser:state', agentId),
  browserNavigate: (agentId: string, url: string): Promise<void> => ipcRenderer.invoke('browser:navigate', agentId, url),
  browserBack: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:back', agentId),
  browserForward: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:forward', agentId),
  browserReload: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:reload', agentId),
  onBrowserUpdate: (cb: (id: string, st: BrowserState) => void) => on<[string, BrowserState]>('browser:update', cb),
  onBrowserActivity: (cb: (id: string) => void) => on<[string]>('browser:activity', cb),

  usage: (): Promise<UsageSnapshot> => ipcRenderer.invoke('usage:read'),
  gitStatus: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', cwd),
  gitPush: (cwd: string): Promise<string> => ipcRenderer.invoke('git:push', cwd),
  gitGraph: (cwd: string, max?: number): Promise<GitCommit[]> => ipcRenderer.invoke('git:graph', cwd, max),
  gitLog: (cwd: string): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', cwd),
  gitMergePlan: (cwd: string): Promise<MergePlan> => ipcRenderer.invoke('git:mergePlan', cwd),
  gitMerge: (cwd: string): Promise<string> => ipcRenderer.invoke('git:merge', cwd),
  gitPublish: (cwd: string): Promise<string> => ipcRenderer.invoke('git:publish', cwd),
  seedPlan: (repoPath: string, worktree: string): Promise<SeedPlan> => ipcRenderer.invoke('seed:plan', repoPath, worktree),
  seedApply: (repoPath: string, worktree: string, items: SeedItem[]): Promise<{ done: string[]; failed: string[] }> =>
    ipcRenderer.invoke('seed:apply', repoPath, worktree, items),
  gitShipPlan: (cwd: string): Promise<ShipPlan> => ipcRenderer.invoke('git:shipPlan', cwd),
  onShipEvent: (cb: (e: ShipEvent) => void) => on<[ShipEvent]>('git:shipEvent', cb),
  gitShip: (cwd: string, message: string): Promise<ShipResult> => ipcRenderer.invoke('git:ship', cwd, message),
  gitPrUrl: (cwd: string): Promise<string | null> => ipcRenderer.invoke('git:prUrl', cwd),
  gitPushBranch: (cwd: string, name: string): Promise<string> => ipcRenderer.invoke('git:pushBranch', cwd, name),
  gitApplyPlan: (cwd: string): Promise<ApplyPlan> => ipcRenderer.invoke('git:applyPlan', cwd),
  gitApply: (cwd: string): Promise<string> => ipcRenderer.invoke('git:apply', cwd),
  gitCommit: (cwd: string, sha: string): Promise<GitCommitDetail> => ipcRenderer.invoke('git:commit', cwd, sha),
  gitBranches: (cwd: string): Promise<GitBranch[]> => ipcRenderer.invoke('git:branches', cwd),
  gitCommitStaged: (cwd: string, message: string): Promise<string> => ipcRenderer.invoke('git:commitStaged', cwd, message),
  gitStage: (cwd: string, paths: string[]): Promise<string> => ipcRenderer.invoke('git:stage', cwd, paths),
  gitUnstage: (cwd: string, paths: string[]): Promise<string> => ipcRenderer.invoke('git:unstage', cwd, paths),
  gitDiff: (cwd: string, path: string, staged: boolean, untracked: boolean, base?: string, sha?: string): Promise<string> =>
    ipcRenderer.invoke('git:diff', cwd, path, staged, untracked, base, sha)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('api', api)
