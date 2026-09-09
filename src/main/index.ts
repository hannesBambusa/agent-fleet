import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { Tailer } from './sessions/tailer'
import { startHookServer } from './hooks/server'
import { hookStatus, installHooks, uninstallHooks } from './hooks/installer'
import { PtyManager } from './pty/manager'
import { AgentRegistry, belongsTo } from './agents/registry'
import { execFile } from 'node:child_process'
import { RepoRegistry } from './repos/registry'
import { BrowserManager, type Bounds } from './browser/manager'
import { startBrowserServer } from './browser/server'
import {
  branches as gitBranches,
  commit as gitCommit,
  commitDetail as gitCommitDetail,
  diff as gitDiff,
  graph as gitGraph,
  log as gitLog,
  applyChanges as gitApply,
  applyPlan as gitApplyPlan,
  merge as gitMerge,
  publish as gitPublish,
  pullRequestUrl as gitPullRequestUrl,
  ship as gitShip,
  shipPlan as gitShipPlan,
  pushAsBranch as gitPushAsBranch,
  mergePlan as gitMergePlan,
  push as gitPush,
  stage as gitStage,
  status as gitStatus,
  unstage as gitUnstage
} from './git'
import { usage } from './usage'
import { catalog } from './catalog'
import { mcpServers } from './catalog/mcp'
import { pickImage, saveImage, thumbnail } from './files/attach'
import { listDir, readTextFile } from './files/browse'
import { seedApply, seedPlan } from './git/seed'
import type { Agent, LaunchRequest, Repo, SeedItem, Session } from '../shared/types'

// same data folder whether started via pnpm dev, a direct electron run, or the packaged app
app.setName('agent-fleet')
app.setPath('userData', join(app.getPath('appData'), 'agent-fleet'))

const tailer = new Tailer()
const ptys = new PtyManager()
let agents: AgentRegistry
let repos: RepoRegistry
let browser: BrowserManager

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1720,
    height: 980,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url)
    return { action: 'deny' }
  })
  // a link in the chat must never replace the app itself
  win.webContents.on('will-navigate', (e, url) => {
    const here = is.dev && process.env['ELECTRON_RENDERER_URL'] ? process.env['ELECTRON_RENDERER_URL'] : null
    if (here && url.startsWith(here)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
    void openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** only ever hand the system a link a browser can open */
async function openExternal(url: string): Promise<void> {
  try {
    const { protocol } = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(protocol)) return
    await shell.openExternal(url)
  } catch {
    // not a URL we can open
  }
}

function broadcast(channel: string, ...payload: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...payload)
}

/**
 * Resume the conversation this agent is actually on, not the id it was launched with. Claude Code
 * forks a new id whenever it resumes a session that is still running, so the recorded id can point
 * at a transcript that stopped hours ago — resuming that one silently rewinds the agent's work.
 */
function resumeLatest(id: string, cols: number, rows: number): Agent | undefined {
  const a = agents.get(id)
  if (!a) return undefined
  const newest = tailer
    .list()
    .filter((s) => belongsTo(a, s))
    .sort((x, y) => (y.lastEventAt ?? '').localeCompare(x.lastEventAt ?? ''))[0]
  if (newest && newest.id !== a.sessionId) agents.rebind(a.id, newest.id, newest.cwd)
  return agents.resume(id, cols, rows)
}

function wireIpc(): void {
  ipcMain.handle('sessions:list', (): Session[] => tailer.list())
  ipcMain.handle('hooks:status', () => hookStatus())
  ipcMain.handle('hooks:install', () => installHooks())
  ipcMain.handle('hooks:uninstall', () => uninstallHooks())

  ipcMain.handle('catalog:list', () => catalog(repos.list().map((r) => r.path)))
  ipcMain.handle('catalog:mcp', () => mcpServers(repos.list().map((r) => r.path)))
  ipcMain.handle('repos:list', (): Repo[] => repos.list())
  ipcMain.handle('repos:upsert', (_, r: Repo): Repo => repos.upsert(r))
  ipcMain.handle('repos:remove', (_, path: string) => repos.remove(path))
  ipcMain.handle('repos:pick', async (): Promise<Repo | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (canceled || !filePaths[0]) return null
    const path = filePaths[0]
    repos.seen(path)
    return repos.get(path) ?? repos.upsert({ path, name: '', trusted: false, hasCommits: false, worktree: true, browser: true, setupCommand: '' })
  })

  ipcMain.handle('agents:list', (): Agent[] => agents.list())
  ipcMain.handle('agents:launch', (_, req: LaunchRequest, cols: number, rows: number): Agent =>
    agents.launch(req, cols, rows)
  )
  ipcMain.handle('agents:resume', (_, id: string, cols: number, rows: number) => resumeLatest(id, cols, rows))
  ipcMain.handle('agents:stop', (_, id: string) => agents.stop(id))
  ipcMain.handle('agents:remove', (_, id: string) => agents.remove(id))
  ipcMain.handle('pty:history', (_, id: string) => ptys.historyOf(id))
  ipcMain.on('pty:write', (_, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.handle('shell:open', (_, path: string) => shell.openPath(path))
  ipcMain.handle('shell:external', (_, url: string) => openExternal(url))

  ipcMain.on('browser:layout', (_, agentId: string | null, b: Bounds | null) => {
    if (agentId) browser.ensure(agentId)
    browser.layout(agentId, b)
  })
  ipcMain.handle('browser:state', (_, agentId: string) => browser.state(agentId))
  ipcMain.handle('browser:navigate', (_, agentId: string, url: string) => browser.navigate(agentId, url))
  ipcMain.handle('browser:back', (_, agentId: string) => browser.back(agentId))
  ipcMain.handle('browser:forward', (_, agentId: string) => browser.forward(agentId))
  ipcMain.handle('browser:reload', (_, agentId: string) => browser.reload(agentId))

  ipcMain.handle('usage:read', () => usage())
  ipcMain.handle('git:status', (_, cwd: string) => gitStatus(cwd))
  ipcMain.handle('git:push', (_, cwd: string) => gitPush(cwd))
  ipcMain.handle('files:saveImage', (_, bytes: Uint8Array, mime: string) => saveImage(bytes, mime))
  ipcMain.handle('files:pickImage', () => pickImage())
  ipcMain.handle('files:thumb', (_, path: string) => thumbnail(path))
  // the roots come from the app's own registry, never from the caller
  ipcMain.handle('files:list', (_, path: string) => listDir(repos.list().map((r) => r.path), path))
  ipcMain.handle('files:read', (_, path: string) => readTextFile(repos.list().map((r) => r.path), path))
  // the pane's own pixels, saved where an agent can read them back
  ipcMain.handle('browser:shot', async (_, agentId: string) => {
    if (!browser.isVisible(agentId)) {
      throw new Error('open this agent\u2019s browser tab first: a parked pane has nothing to capture')
    }
    const res = (await browser.cdp(agentId, 'Page.captureScreenshot', { format: 'png' }, 8000)) as { data: string }
    return saveImage(Buffer.from(res.data, 'base64'), 'image/png')
  })
  ipcMain.handle('git:graph', (_, cwd: string, max?: number) => gitGraph(cwd, max))
  ipcMain.handle('git:log', (_, cwd: string) => gitLog(cwd))
  ipcMain.handle('git:mergePlan', (_, cwd: string) => gitMergePlan(cwd))
  ipcMain.handle('git:merge', (_, cwd: string) => gitMerge(cwd))
  ipcMain.handle('git:publish', (_, cwd: string) => gitPublish(cwd))
  ipcMain.handle('seed:plan', (_, repoPath: string, worktree: string) => seedPlan(repoPath, worktree))
  ipcMain.handle('seed:apply', (_, repoPath: string, worktree: string, items: SeedItem[]) =>
    seedApply(repoPath, worktree, items)
  )
  ipcMain.handle('git:shipPlan', (_, cwd: string) => gitShipPlan(cwd))
  ipcMain.handle('git:ship', (e, cwd: string, message: string) =>
    gitShip(cwd, message, (ev) => e.sender.send('git:shipEvent', ev))
  )
  ipcMain.handle('git:prUrl', (_, cwd: string) => gitPullRequestUrl(cwd))
  ipcMain.handle('git:pushBranch', (_, cwd: string, name: string) => gitPushAsBranch(cwd, name))
  ipcMain.handle('git:applyPlan', (_, cwd: string) => gitApplyPlan(cwd))
  ipcMain.handle('git:apply', (_, cwd: string) => gitApply(cwd))
  ipcMain.handle('git:commit', (_, cwd: string, sha: string) => gitCommitDetail(cwd, sha))
  ipcMain.handle('git:branches', (_, cwd: string) => gitBranches(cwd))
  ipcMain.handle('git:commitStaged', (_, cwd: string, message: string) => gitCommit(cwd, message))
  ipcMain.handle('git:stage', (_, cwd: string, paths: string[]) => gitStage(cwd, paths))
  ipcMain.handle('git:unstage', (_, cwd: string, paths: string[]) => gitUnstage(cwd, paths))
  ipcMain.handle(
    'git:diff',
    (_, cwd: string, path: string, staged: boolean, untracked: boolean, base?: string, sha?: string) =>
      gitDiff(cwd, path, staged, untracked, base, sha)
  )
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('se.bambusa.agent-fleet')
  // A packaged app carries its icon in the bundle. In development Electron shows its own, which
  // makes the dev window hard to pick out of a Dock that already has the real app in it.
  if (!app.isPackaged) {
    app.dock?.setIcon(join(app.getAppPath(), 'resources', 'icon.png'))
  }
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  agents = new AgentRegistry(ptys)
  repos = new RepoRegistry()
  browser = new BrowserManager(() => BrowserWindow.getAllWindows()[0] ?? null)
  wireIpc()

  tailer.on('update', (s: Session) => {
    if (!s.parentId) repos.seen(s.cwd)
    broadcast('sessions:update', s)
    const list = agents.list()
    const owner = list.find((a) => a.sessionId === s.id)
    if (owner) {
      // a session the tailer has given up on cannot bring its agent back to life
      if (s.state !== 'ended' && !s.closed) agents.markLive(owner.id, s.cwd)
    } else if (!s.parentId && s.firstEventAt) {
      // an unclaimed session in an agent's own directory, started after it, is that agent's
      const orphan = list.find(
        (a) =>
          a.status !== 'exited' &&
          !tailer.get(a.sessionId) &&
          belongsTo(a, s) &&
          Date.parse(s.firstEventAt!) >= Date.parse(a.createdAt) - 10_000
      )
      if (orphan) agents.rebind(orphan.id, s.id, s.cwd)
    }
  })
  // detached agents live in tmux, so their liveness is whatever tmux still has
  const pollTmux = (): void => {
    execFile('tmux', ['ls', '-F', '#{session_name}'], (_e, out) => {
      agents.syncDetached(new Set((out ?? '').split('\n').map((l) => l.trim()).filter(Boolean)))
    })
  }
  pollTmux()
  setInterval(pollTmux, 5000)

  tailer.start()
  startHookServer(tailer, (e) => broadcast('hooks:event', e))

  ptys.on('data', (id: string, data: string) => broadcast('pty:data', id, data))
  const syncOwned = (): void => tailer.setOwned(agents.list().filter((a) => a.status !== 'exited').map((a) => a.sessionId))
  agents.on('update', (a: Agent) => {
    syncOwned()
    broadcast('agents:update', a)
  })
  syncOwned()
  agents.on('removed', (id: string) => {
    browser.destroy(id)
    broadcast('agents:removed', id)
  })
  browser.on('state', (id: string, st: unknown) => broadcast('browser:update', id, st))
  startBrowserServer(browser, (id) => broadcast('browser:activity', id))

  createWindow()
  // bring back whatever was running when the app last quit, once the tailer knows which
  // conversation each agent is actually on
  setTimeout(() => {
    for (const a of agents.interrupted()) resumeLatest(a.id, 120, 36)
  }, 2500)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (e) => {
  const live = agents?.list().filter((a) => a.status !== 'exited') ?? []
  if (!live.length) return
  const r = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Quit anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `${live.length} agent${live.length > 1 ? 's' : ''} still running`,
    detail: live.map((a) => `• ${a.repoName} / ${a.name}`).join('\n') + '\n\nThey can be resumed after relaunch.'
  })
  if (r === 1) e.preventDefault()
  else {
    agents.markInterrupted()
    ptys.killAll()
    browser.destroyAll()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
