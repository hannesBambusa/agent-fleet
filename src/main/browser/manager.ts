import { BrowserWindow, WebContentsView, session } from 'electron'
import { EventEmitter } from 'node:events'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ConsoleEntry {
  level: string
  text: string
  at: string
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

// one embedded Chromium per agent, each in its own storage partition
export class BrowserManager extends EventEmitter {
  private views = new Map<string, Entry>()
  private visible: string | null = null
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

  constructor(private getWindow: () => BrowserWindow | null) {
    super()
  }

  has(agentId: string): boolean {
    return this.views.has(agentId)
  }

  isVisible(agentId: string): boolean {
    return this.visible === agentId
  }

  ensure(agentId: string): Entry {
    const found = this.views.get(agentId)
    if (found) return found
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
    this.views.set(agentId, entry)

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
      void view.webContents.loadURL(url)
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
    const entry = this.views.get(agentId)
    if (!entry) return
    this.attach(entry)
    if (!entry.inWindow) return
    entry.view.setBounds(this.bounds)
  }

  // parked off-screen rather than detached, so the page keeps running and stays capturable
  hide(agentId: string): void {
    const entry = this.views.get(agentId)
    if (!entry?.inWindow) return
    entry.view.setBounds(PARKED)
    if (this.visible === agentId) this.visible = null
  }

  destroy(agentId: string): void {
    const entry = this.views.get(agentId)
    if (!entry) return
    const win = this.getWindow()
    if (win && entry.inWindow) {
      win.contentView.removeChildView(entry.view)
      entry.inWindow = false
    }
    if (this.visible === agentId) this.visible = null
    try {
      if (entry.attached) entry.view.webContents.debugger.detach()
    } catch {
      // already detached
    }
    entry.view.webContents.close()
    this.views.delete(agentId)
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }

  state(agentId: string): { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean } | null {
    const entry = this.views.get(agentId)
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
    return this.views.get(agentId)?.console ?? []
  }
  netOf(agentId: string): NetEntry[] {
    return this.views.get(agentId)?.net ?? []
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
