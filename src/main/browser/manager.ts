import { BrowserWindow, WebContentsView, session } from 'electron'
import { EventEmitter } from 'node:events'
import type { ConsoleEntry } from '../../shared/types'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NetEntry {
  method: string
  url: string
  status?: number
  type?: string
  at: string
}

const RING = 200
// parked views stay inside the window as a single pixel: fully off-screen they lose their
// compositor surface and every devtools command that needs to render hangs forever
const PARKED = { x: 0, y: 0, width: 1, height: 1 }

// a brand new view holds no document at all and paints nothing, which reads as "the browser is
// broken"; this is what an empty pane should look like instead
const START_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><style>
      html,body{height:100%;margin:0;background:#0b0d10;color:#7c8592;
        font:13px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
      div{text-align:center;line-height:1.7}
      b{color:#e6e9ef;font-weight:600}
      code{color:#5ee0a0;font-family:ui-monospace,Menlo,monospace}
     </style><div><b>Browser ready</b><br>Type a URL above, or ask this agent to open one.<br>
     <code>browser_navigate</code> puts the page here.</div>`
  )

interface Entry {
  view: WebContentsView
  console: ConsoleEntry[]
  net: NetEntry[]
  attached: boolean
  inWindow: boolean
}

/**
 * The tabs of one agent. They share a storage partition, which is what makes them tabs of the same
 * browser rather than unrelated windows: a login in one is a login in all of them.
 */
interface Tabs {
  list: Entry[]
  active: number
}

// one embedded Chromium per agent, each in its own storage partition, each with its own tabs
export class BrowserManager extends EventEmitter {
  private agents = new Map<string, Tabs>()
  private visible: string | null = null
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

  constructor(private getWindow: () => BrowserWindow | null) {
    super()
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId)
  }

  /** The tab everything else means when it says "the browser": whichever one is on screen. */
  private entryOf(agentId: string): Entry | undefined {
    const tabs = this.agents.get(agentId)
    return tabs?.list[tabs.active]
  }

  isVisible(agentId: string): boolean {
    return this.visible === agentId
  }

  ensure(agentId: string): Entry {
    const found = this.entryOf(agentId)
    if (found) return found
    const tabs: Tabs = this.agents.get(agentId) ?? { list: [], active: 0 }
    this.agents.set(agentId, tabs)
    const entry = this.makeTab(agentId)
    tabs.list.push(entry)
    tabs.active = tabs.list.length - 1
    return entry
  }

  /** One tab: its own page, its own console and network log, sharing the agent's partition. */
  private makeTab(agentId: string): Entry {
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:agent-${agentId}`,
        session: session.fromPartition(`persist:agent-${agentId}`),
        sandbox: true,
        contextIsolation: true
      }
    })
    view.setBackgroundColor('#0b0d10')
    const entry: Entry = { view, console: [], net: [], attached: false, inWindow: false }

    // typed as returning void in some Electron builds and boolean in others; keep the body statement-only
    view.webContents.on('console-message', (_e: unknown, level: unknown, message: string) => {
      push(entry.console, { level: String(level), text: message, at: new Date().toISOString() })
    })
    const emit = (): void => {
      this.emit('state', agentId, this.state(agentId))
    }
    view.webContents.on('did-navigate', emit)
    view.webContents.on('did-navigate-in-page', emit)
    view.webContents.on('page-title-updated', emit)
    view.webContents.on('did-start-loading', emit)
    view.webContents.on('did-stop-loading', emit)
    view.webContents.setWindowOpenHandler(({ url }) => {
      // target=_blank is a request for another tab, and now there is somewhere to put it
      this.newTab(agentId, url)
      return { action: 'deny' }
    })

    try {
      view.webContents.debugger.attach('1.3')
      entry.attached = true
      void view.webContents.debugger.sendCommand('Network.enable')
      view.webContents.debugger.on('message', (_e, method, params) => {
        const p = params as Record<string, unknown>
        if (method === 'Network.requestWillBeSent') {
          const req = p.request as { method: string; url: string } | undefined
          if (req) push(entry.net, { method: req.method, url: req.url, type: String(p.type ?? ''), at: new Date().toISOString() })
        } else if (method === 'Network.responseReceived') {
          const res = p.response as { url: string; status: number } | undefined
          if (!res) return
          const hit = [...entry.net].reverse().find((n) => n.url === res.url && n.status === undefined)
          if (hit) hit.status = res.status
        }
      })
    } catch (err) {
      console.error('[browser] debugger attach failed', err)
    }

    // A view that is not in a window has no compositor: loads stall and captureScreenshot never
    // returns. So every view is attached immediately and simply parked until shown.
    this.attach(entry)
    void view.webContents.loadURL(START_PAGE)
    return entry
  }

  private attach(entry: Entry): void {
    if (entry.inWindow) return
    const win = this.getWindow()
    if (!win) return
    win.contentView.addChildView(entry.view)
    entry.inWindow = true
    entry.view.setBounds(PARKED)
  }

  // the renderer owns the layout; it tells us the rectangle and which agent is on screen
  layout(agentId: string | null, b: Bounds | null): void {
    if (b) this.bounds = b
    if (this.visible && this.visible !== agentId) this.hide(this.visible)
    this.visible = agentId
    if (!agentId) return
    const entry = this.entryOf(agentId)
    if (!entry) return
    this.attach(entry)
    if (!entry.inWindow) return
    entry.view.setBounds(this.bounds)
  }

  // parked off-screen rather than detached, so the page keeps running and stays capturable
  hide(agentId: string): void {
    const entry = this.entryOf(agentId)
    if (!entry?.inWindow) return
    entry.view.setBounds(PARKED)
    if (this.visible === agentId) this.visible = null
  }

  /** Closes one tab and takes it out of the window; the agent keeps the rest. */
  private discard(entry: Entry): void {
    const win = this.getWindow()
    if (win && entry.inWindow) {
      win.contentView.removeChildView(entry.view)
      entry.inWindow = false
    }
    try {
      if (entry.attached) entry.view.webContents.debugger.detach()
    } catch {
      // already detached
    }
    entry.view.webContents.close()
  }

  destroy(agentId: string): void {
    const tabs = this.agents.get(agentId)
    if (!tabs) return
    for (const entry of tabs.list) this.discard(entry)
    if (this.visible === agentId) this.visible = null
    this.agents.delete(agentId)
  }

  /** Every tab of an agent, for the strip that draws them. */
  tabs(agentId: string): Array<{ url: string; title: string; loading: boolean }> {
    const tabs = this.agents.get(agentId)
    if (!tabs) return []
    return tabs.list.map((e) => ({
      url: e.view.webContents.getURL(),
      title: e.view.webContents.getTitle(),
      loading: e.view.webContents.isLoading()
    }))
  }

  activeTab(agentId: string): number {
    return this.agents.get(agentId)?.active ?? 0
  }

  newTab(agentId: string, url?: string): number {
    this.ensure(agentId)
    const tabs = this.agents.get(agentId)!
    const entry = this.makeTab(agentId)
    tabs.list.push(entry)
    tabs.active = tabs.list.length - 1
    if (url) void this.navigate(agentId, url)
    // the new tab has to be put where the old one was, or nothing is on screen
    this.layout(this.visible === agentId ? agentId : null, null)
    this.emit('state', agentId, this.state(agentId))
    return tabs.active
  }

  selectTab(agentId: string, index: number): void {
    const tabs = this.agents.get(agentId)
    if (!tabs || !tabs.list[index] || tabs.active === index) return
    // park the one leaving rather than detaching it: a parked page keeps running
    tabs.list[tabs.active]?.view.setBounds(PARKED)
    tabs.active = index
    this.layout(this.visible === agentId ? agentId : null, null)
    this.emit('state', agentId, this.state(agentId))
  }

  closeTab(agentId: string, index: number): void {
    const tabs = this.agents.get(agentId)
    const entry = tabs?.list[index]
    if (!tabs || !entry) return
    // the last tab is not closed, it is emptied: an agent with a browser always has one
    if (tabs.list.length === 1) {
      void entry.view.webContents.loadURL(START_PAGE)
      return
    }
    this.discard(entry)
    tabs.list.splice(index, 1)
    tabs.active = Math.min(tabs.active > index ? tabs.active - 1 : tabs.active, tabs.list.length - 1)
    this.layout(this.visible === agentId ? agentId : null, null)
    this.emit('state', agentId, this.state(agentId))
  }

  destroyAll(): void {
    for (const id of [...this.agents.keys()]) this.destroy(id)
  }

  state(agentId: string): { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean } | null {
    const entry = this.entryOf(agentId)
    if (!entry) return null
    const wc = entry.view.webContents
    const url = wc.getURL()
    return {
      url: url.startsWith('data:') ? '' : url,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  consoleOf(agentId: string): ConsoleEntry[] {
    return this.entryOf(agentId)?.console ?? []
  }

  /**
   * The real DevTools, in a window of its own.
   *
   * The pane is already Chromium, so the full inspector is one call away: elements, network, sources,
   * the proper console. It opens detached rather than docked because a `WebContentsView` has no
   * window chrome for DevTools to dock into, and a detached inspector can also be put on a second
   * screen, which is what anyone doing this for real wants anyway.
   */
  devtools(agentId: string): boolean {
    const entry = this.entryOf(agentId)
    if (!entry) return false
    const wc = entry.view.webContents
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools()
      return false
    }
    wc.openDevTools({ mode: 'detach' })
    return true
  }

  devtoolsOpen(agentId: string): boolean {
    return this.entryOf(agentId)?.view.webContents.isDevToolsOpened() ?? false
  }

  clearConsole(agentId: string): void {
    const entry = this.entryOf(agentId)
    if (entry) entry.console.length = 0
  }
  netOf(agentId: string): NetEntry[] {
    return this.entryOf(agentId)?.net ?? []
  }

  async cdp(agentId: string, method: string, params?: Record<string, unknown>, timeoutMs = 8000): Promise<unknown> {
    const entry = this.ensure(agentId)
    if (!entry.attached) throw new Error('devtools protocol not attached for this agent')
    // some commands never resolve when the view has no on-screen surface; fail loudly instead
    return Promise.race([
      entry.view.webContents.debugger.sendCommand(method, params),
      new Promise((_r, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs))
    ])
  }

  async js<T>(agentId: string, expression: string): Promise<T> {
    const entry = this.ensure(agentId)
    return entry.view.webContents.executeJavaScript(expression, true) as Promise<T>
  }

  async navigate(agentId: string, url: string): Promise<string> {
    const entry = this.ensure(agentId)
    const full = /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`
    // the start page (or a slow previous load) would otherwise abort this one
    entry.view.webContents.stop()
    try {
      await entry.view.webContents.loadURL(full)
    } catch (err) {
      const e = err as { errno?: number; code?: string }
      // a load replaced by a redirect or a newer navigation is not a failure
      if (e.code !== 'ERR_ABORTED') throw err
    }
    return entry.view.webContents.getURL() || full
  }

  async back(agentId: string): Promise<void> {
    const wc = this.ensure(agentId).view.webContents
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  forward(agentId: string): void {
    const wc = this.ensure(agentId).view.webContents
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(agentId: string): void {
    const wc = this.ensure(agentId).view.webContents
    if (wc.isLoading()) wc.stop()
    else wc.reload()
  }
}

function push<T>(ring: T[], item: T): void {
  ring.push(item)
  if (ring.length > RING) ring.splice(0, ring.length - RING)
}
