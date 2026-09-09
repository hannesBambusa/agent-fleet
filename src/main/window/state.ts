import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'

const FILE = (): string => join(app.getPath('userData'), 'window.json')

// the size the green button restores down to, and the size of a first-ever launch once unmaximized
const DEFAULT = { width: 1720, height: 980 }

type Saved = { bounds: Rectangle; maximized: boolean }

function isRect(b: unknown): b is Rectangle {
  const r = b as Rectangle | undefined
  return (
    !!r &&
    [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    r.width > 0 &&
    r.height > 0
  )
}

function overlaps(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * A display that is gone, or a resolution that shrank, leaves a saved rectangle somewhere the user
 * cannot drag the window back from. Only reuse a position that still lands on a real display.
 */
function onScreen(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => overlaps(d.workArea, b))
}

export class WindowState {
  private saved: Saved | null = null

  constructor() {
    try {
      const s = JSON.parse(readFileSync(FILE(), 'utf8')) as Saved
      if (isRect(s.bounds)) this.saved = { bounds: s.bounds, maximized: !!s.maximized }
    } catch {
      // first run, or a file we cannot parse: the defaults below apply
    }
  }

  /** constructor geometry, always the restored-down size so the green button has somewhere to go */
  options(): Pick<Rectangle, 'width' | 'height'> & Partial<Rectangle> {
    const b = this.saved?.bounds
    if (!b || !onScreen(b)) return { ...DEFAULT }
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  }

  /** nothing remembered opens maximized, which is not fullscreen: the menu bar stays visible */
  maximized(): boolean {
    return this.saved?.maximized ?? true
  }

  track(win: BrowserWindow): void {
    const save = (maximized: boolean): void => {
      // getBounds() while maximized is the screen, which would be remembered as the small size
      this.saved = { bounds: win.getNormalBounds(), maximized }
      try {
        // straight to disk on the event, never buffered for quit: this app is routinely killed with
        // kill -9, which is how the renderer's localStorage pane widths keep getting lost
        writeFileSync(FILE(), JSON.stringify(this.saved, null, 2))
      } catch {
        // a remembered window position is not worth throwing out of an event handler for
      }
    }
    // 'resized' and 'moved' fire once when the drag ends, unlike 'resize' and 'move'
    win.on('resized', () => save(win.isMaximized()))
    win.on('moved', () => save(win.isMaximized()))
    win.on('maximize', () => save(true))
    win.on('unmaximize', () => save(false))
  }
}
