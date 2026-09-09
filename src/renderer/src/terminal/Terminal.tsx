import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { currentTheme, THEME_EVENT, type Theme } from '../state/theme'

// xterm paints on a canvas, so it cannot read CSS variables; it is handed the theme instead
function xtermTheme(t: Theme): Record<string, string> {
  return {
    background: t.vars.ink,
    foreground: t.vars.fg,
    cursor: t.vars.accent,
    selectionBackground: `${t.vars.accent}40`,
    black: t.vars.ink,
    brightBlack: t.vars.dim
  }
}

// one xterm per agent id, kept alive across tab switches so scrollback survives
const pool = new Map<string, { term: XTerm; fit: FitAddon; primed: boolean }>()
let wired = false

function ensureWired(): void {
  if (wired) return
  wired = true
  window.addEventListener(THEME_EVENT, (e) => {
    const t = (e as CustomEvent<Theme>).detail
    for (const entry of pool.values()) entry.term.options.theme = xtermTheme(t)
  })
  window.api.onPtyData((id, data) => {
    const t = pool.get(id)
    // before the history replay lands, live data is already part of that history
    if (t && t.primed) t.term.write(data)
  })
}

export function termSize(): { cols: number; rows: number } {
  return { cols: 120, rows: 36 }
}

function get(id: string): { term: XTerm; fit: FitAddon; primed: boolean } {
  let t = pool.get(id)
  if (t) return t
  const term = new XTerm({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    // Option+Enter then arrives as ESC CR, the same as in iTerm
    macOptionIsMeta: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: xtermTheme(currentTheme())
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  // Enter submits in Claude Code, so a newline has to arrive as something else. Terminals send CR
  // for Enter; a bare LF is what "send text \n" bindings produce and what the TUI treats as a new
  // line. Ctrl+Enter keeps the meta+enter form as a fallback for anything that wants that instead.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || e.key !== 'Enter') return true
    if (e.shiftKey) {
      window.api.ptyWrite(id, '\n')
      return false
    }
    if (e.ctrlKey) {
      window.api.ptyWrite(id, '\x1b\r')
      return false
    }
    return true
  })
  term.onData((d) => window.api.ptyWrite(id, d))
  term.onResize(({ cols, rows }) => window.api.ptyResize(id, cols, rows))
  t = { term, fit, primed: false }
  pool.set(id, t)
  // anything the pty printed before this pane existed
  void window.api.ptyHistory(id).then((h) => {
    const cur = pool.get(id)
    if (cur && !cur.primed) {
      cur.primed = true
      if (h) cur.term.write(h)
    }
  })
  return t
}

export function disposeTerminal(id: string): void {
  const t = pool.get(id)
  if (!t) return
  t.term.dispose()
  pool.delete(id)
}

export function Terminal({ id }: { id: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ensureWired()
    const el = ref.current
    if (!el) return
    const { term, fit } = get(id)
    if (!term.element) term.open(el)
    else el.appendChild(term.element)
    const doFit = (): void => {
      try {
        fit.fit()
      } catch {
        // not laid out yet
      }
    }
    doFit()
    term.focus()
    const ro = new ResizeObserver(doFit)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (term.element && term.element.parentElement === el) el.removeChild(term.element)
    }
  }, [id])
  // no-scale keeps the terminal at its own font size while the rest of the app scales
  return <div ref={ref} className="no-scale h-full w-full px-2 pt-2" />
}
