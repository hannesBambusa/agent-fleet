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
    if (sessionId) this.seen(sessionId)
  }

  /**
   * Everything this session was flagged for, cleared because you have now looked at it.
   *
   * Opening an agent is the same statement as dismissing its row: you have read what it did. Without
   * this the card would keep asking for attention it has already had.
   */
  seen(sessionId: string): void {
    const before = this.items.length
    this.items = this.items.filter((i) => i.sessionId !== sessionId)
    if (this.items.length !== before) this.emit('update', this.items)
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
      this.push(s, 'waiting')
      return
    }
    // a turn ending: running or waiting, then quiet
    if (s.state === 'idle' && (before === 'running' || before === 'waiting') && this.settings.onDone) {
      const ran = Date.now() - (this.startedAt.get(s.id) ?? Date.now())
      this.startedAt.delete(s.id)
      if (ran < WORTH_TELLING_MS) return
      this.push(s, 'done')
    }
  }

  /**
   * What this turn was about, in a few words.
   *
   * A slash command is the best answer when there is one — "/commit finished" says more than any
   * summary — and the two timestamps say which of the command and the prompt actually started this
   * turn. Failing both, the first line of what was asked.
   */
  private about(s: Session): string {
    const cmd = s.commands[s.commands.length - 1]
    const cmdAt = cmd ? Date.parse(cmd.at) : 0
    const promptAt = s.lastPromptAt ? Date.parse(s.lastPromptAt) : 0
    if (cmd && cmdAt >= promptAt) return cmd.name
    return s.lastPrompt?.split('\n')[0]?.slice(0, 80) ?? ''
  }

  private push(s: Session, kind: AttentionItem['kind']): void {
    const item: AttentionItem = {
      id: `${s.id}-${kind}-${Date.now()}`,
      sessionId: s.id,
      kind,
      repo: s.repo,
      worktree: s.worktree,
      title: s.topic ?? s.lastPrompt?.split('\n')[0]?.slice(0, 60) ?? s.repo,
      detail: this.about(s),
      at: new Date().toISOString()
    }
    // one entry per session per kind: an agent that flickers should not fill the queue
    this.items = [item, ...this.items.filter((i) => !(i.sessionId === s.id && i.kind === kind))].slice(0, KEEP)
    this.emit('update', this.items)
    this.announce(item)
  }

  /**
   * A system notification, unless you are already looking straight at the thing it is about.
   *
   * Three lines, because a notification is read at a glance from across the room: which agent, where
   * it was working, and what it was doing. "backend · done" told you nothing you could act on.
   */
  private announce(item: AttentionItem): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win?.isFocused() && this.looking === item.sessionId) return
    if (!Notification.isSupported()) return
    const where = item.worktree ? `${item.repo} · ${item.worktree}` : item.repo
    const n = new Notification({
      title: item.title,
      subtitle: item.kind === 'waiting' ? `${where} — needs your approval` : `${where} — finished`,
      body: item.detail
        ? item.kind === 'waiting'
          ? `waiting during ${item.detail}`
          : `done with ${item.detail}`
        : item.kind === 'waiting'
          ? 'it cannot go further without you'
          : 'waiting for what to do next',
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
