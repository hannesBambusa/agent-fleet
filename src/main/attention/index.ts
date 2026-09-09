import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Notification } from 'electron'
import type { AttentionItem, AttentionSettings, Session } from '../../shared/types'

const FILE = (): string => join(app.getPath('userData'), 'attention.json')
const KEEP = 50
// a turn that ended in under this was not something you walked away from
const WORTH_TELLING_MS = 20 * 1000

const DEFAULTS: AttentionSettings = {
  onWaiting: true,
  onDone: true,
  // a session you started in a terminal is one you are probably already watching
  appAgentsOnly: false,
  sound: false
}

/**
 * What needs you, and telling you about it.
 *
 * The point of running many agents is not to watch them, and the two moments that actually require a
 * person are narrow: one is blocked on an approval, or one has finished and is waiting for the next
 * instruction. Everything else is noise, so nothing else is announced.
 *
 * State comes from the tailer, which already decides it. This only watches for the *transitions*,
 * because a session that has been idle for an hour is not news.
 */
export class Attention extends EventEmitter {
  private items: AttentionItem[] = []
  private was = new Map<string, Session['state']>()
  private startedAt = new Map<string, number>()
  private settings: AttentionSettings = { ...DEFAULTS }
  /** the session on screen right now, if the window has focus: it needs no announcement */
  private looking: string | null = null

  constructor() {
    super()
    try {
      this.settings = { ...DEFAULTS, ...(JSON.parse(readFileSync(FILE(), 'utf8')) as AttentionSettings) }
    } catch {
      // first run
    }
  }

  list(): AttentionItem[] {
    return this.items
  }

  prefs(): AttentionSettings {
    return this.settings
  }

  setPrefs(next: Partial<AttentionSettings>): AttentionSettings {
    this.settings = { ...this.settings, ...next }
    try {
      writeFileSync(FILE(), JSON.stringify(this.settings, null, 2))
    } catch {
      // preferences that will not persist still work for this run
    }
    return this.settings
  }

  watching(sessionId: string | null): void {
    this.looking = sessionId
  }

  dismiss(id: string): void {
    this.items = this.items.filter((i) => i.id !== id)
    this.emit('update', this.items)
  }

  clear(): void {
    this.items = []
    this.emit('update', this.items)
  }

  /**
   * Every session update passes through here. `owned` says the app launched it, which is the only
   * thing this cannot work out for itself.
   */
  saw(s: Session, owned: boolean): void {
    if (s.parentId) return
    const before = this.was.get(s.id)
    this.was.set(s.id, s.state)
    if (s.state === 'running') this.startedAt.set(s.id, this.startedAt.get(s.id) ?? Date.now())
    // the first sighting of a session is not a transition: on startup every session is "new"
    if (before === undefined || before === s.state) return
    if (this.settings.appAgentsOnly && !owned) return

    if (s.state === 'waiting' && this.settings.onWaiting) {
      this.push(s, 'waiting', 'needs your approval')
      return
    }
    // a turn ending: running or waiting, then quiet
    if (s.state === 'idle' && (before === 'running' || before === 'waiting') && this.settings.onDone) {
      const ran = Date.now() - (this.startedAt.get(s.id) ?? Date.now())
      this.startedAt.delete(s.id)
      if (ran < WORTH_TELLING_MS) return
      this.push(s, 'done', 'finished and is waiting for you')
    }
  }

  private push(s: Session, kind: AttentionItem['kind'], what: string): void {
    const item: AttentionItem = {
      id: `${s.id}-${kind}-${Date.now()}`,
      sessionId: s.id,
      kind,
      repo: s.repo,
      title: s.topic ?? s.lastPrompt?.split('\n')[0]?.slice(0, 60) ?? s.repo,
      at: new Date().toISOString()
    }
    // one entry per session per kind: an agent that flickers should not fill the queue
    this.items = [item, ...this.items.filter((i) => !(i.sessionId === s.id && i.kind === kind))].slice(0, KEEP)
    this.emit('update', this.items)
    this.announce(item, what)
  }

  /** A system notification, unless you are already looking straight at the thing it is about. */
  private announce(item: AttentionItem, what: string): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win?.isFocused() && this.looking === item.sessionId) return
    if (!Notification.isSupported()) return
    const n = new Notification({
      title: `${item.repo} · ${item.kind === 'waiting' ? 'needs you' : 'done'}`,
      body: `${item.title} ${what}`,
      silent: !this.settings.sound
    })
    n.on('click', () => {
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      this.emit('open', item.sessionId)
    })
    n.show()
  }
}
