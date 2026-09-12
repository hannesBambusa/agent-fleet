import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { currentTheme, THEME_EVENT, type Theme } from '../state/theme'

// xterm paints on a canvas, so it cannot read CSS variables; it is handed the theme instead
// The sixteen colours the CLI actually paints with. xterm's defaults are tuned for a dark ground:
// on a light theme its pale cyan and yellow all but vanish, which is what made a light terminal
// unreadable. So both grounds get their own set — dark keeps the familiar bright palette, light gets
// saturated, darker inks that hold contrast against paper.
const ANSI_DARK = {
  black: '#3b4048',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#d19a66',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#c8ccd4',
  brightBlack: '#5c6370',
  brightRed: '#ff7b86',
  brightGreen: '#b5e890',
  brightYellow: '#e5c07b',
  brightBlue: '#7cc4ff',
  brightMagenta: '#dd9ff0',
  brightCyan: '#6fd3df',
  brightWhite: '#ffffff'
}

const ANSI_LIGHT = {
  black: '#2b2f36',
  red: '#b3261e',
  green: '#1b6e3c',
  yellow: '#8a5a00',
  blue: '#1d4ed8',
  magenta: '#8e24aa',
  cyan: '#00695c',
  white: '#4a5058',
  // "bright" on paper cannot mean lighter, or it means invisible: it means a shade along, still ink
  brightBlack: '#5c6370',
  brightRed: '#d13c2e',
  brightGreen: '#2f8a4c',
  brightYellow: '#a06f00',
  brightBlue: '#2f63e8',
  brightMagenta: '#a03bbd',
  brightCyan: '#00786a',
  brightWhite: '#1b1f24'
}

function xtermTheme(t: Theme): Record<string, string> {
  return {
    ...(t.dark ? ANSI_DARK : ANSI_LIGHT),
    background: t.vars.ink,
    foreground: t.vars.fg,
    cursor: t.vars.accent,
    cursorAccent: t.vars.ink,
    selectionBackground: `${t.vars.accent}40`,
    // The theme's own inks only win where they are still legible. On a light ground `--dim` is a
    // mid grey chosen to recede against panels, and the CLI paints half its own chrome in
    // brightBlack: hints, elapsed times, "+4 lines". Recessive there means gone.
    black: t.dark ? t.vars.ink : ANSI_LIGHT.black,
    brightBlack: t.dark ? t.vars.dim : ANSI_LIGHT.brightBlack
  }
}

/**
 * The floor xterm holds any foreground to against the background it is painted on.
 *
 * The palette above only reaches the sixteen ANSI colours. Claude Code also emits 256-colour and
 * true-colour text — file paths, commit subjects, its own dimmed prose — all picked for a dark
 * terminal, and nothing in a theme can reach those. xterm can, by lifting whatever it is handed
 * until it is readable, which is the only thing that covers colours chosen by another program.
 *
 * Dark grounds keep 1 (untouched): the CLI's palette already works there, and raising it flattens
 * the deliberate dimming that makes its output scannable.
 */
function contrastFloor(t: Theme): number {
  return t.dark ? 1 : 4.5
}

// one xterm per agent id, kept alive across tab switches so scrollback survives
const pool = new Map<string, { term: XTerm; fit: FitAddon; primed: boolean }>()
let wired = false

function ensureWired(): void {
  if (wired) return
  wired = true
  window.addEventListener(THEME_EVENT, (e) => {
    const t = (e as CustomEvent<Theme>).detail
    for (const entry of pool.values()) {
      entry.term.options.theme = xtermTheme(t)
      entry.term.options.minimumContrastRatio = contrastFloor(t)
    }
  })
  window.api.pty.onData((id, data) => {
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
    theme: xtermTheme(currentTheme()),
    minimumContrastRatio: contrastFloor(currentTheme())
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
      window.api.pty.write(id, '\n')
      return false
    }
    if (e.ctrlKey) {
      window.api.pty.write(id, '\x1b\r')
      return false
    }
    return true
  })
  term.onData((d) => window.api.pty.write(id, d))
  term.onResize(({ cols, rows }) => window.api.pty.resize(id, cols, rows))
  t = { term, fit, primed: false }
  pool.set(id, t)
  // anything the pty printed before this pane existed
  void window.api.pty.history(id).then((h) => {
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
