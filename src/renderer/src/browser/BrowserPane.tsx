import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Agent, BrowserState, BrowserTab, ConsoleEntry } from '../../../shared/types'
import { onOverlayChange, overlaysOpen } from '../state/overlay'
import { usePersisted } from '../state/persist'

function NavButton({
  label,
  title,
  disabled,
  onClick
}: {
  label: string
  title: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="h-6 w-6 shrink-0 rounded border border-[var(--line)] text-[12px] leading-none text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-25 disabled:hover:border-[var(--line)] disabled:hover:text-[var(--muted)]"
    >
      {label}
    </button>
  )
}

// The Chromium view is a native child of the window, not a DOM node. This component reserves the
// space and reports its rectangle to main, which positions the view on top of it.
export function BrowserPane({ agent }: { agent: Agent | null }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState | null>(null)
  const [url, setUrl] = useState('')
  const [editing, setEditing] = useState(false)
  const id = agent && agent.browser ? agent.id : null
  // the console buffer lives in the main process, where the page's messages arrive
  const [consoleOpen, setConsoleOpen] = usePersisted<boolean>('browserConsoleOpen', false)
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  useEffect(() => {
    if (!consoleOpen || !id) return
    const read = (): void => {
      void window.api.browser.console(id).then(setEntries)
    }
    read()
    const t = setInterval(read, 1200)
    return () => clearInterval(t)
  }, [consoleOpen, id])
  const [devtools, setDevtools] = useState(false)
  // the tabs live in main, where the views do; this is a picture of them
  const [tabs, setTabs] = useState<{ tabs: BrowserTab[]; active: number }>({ tabs: [], active: 0 })
  const readTabs = useCallback((): void => {
    if (!id) return
    void window.api.browser.tabs(id).then(setTabs)
  }, [id])
  useEffect(() => {
    readTabs()
    const t = setInterval(readTabs, 1500)
    return () => clearInterval(t)
  }, [readTabs, state?.url, state?.title, state?.loading])
  useEffect(() => {
    if (!id) return
    void window.api.browser.devtoolsOpen(id).then(setDevtools)
  }, [id])
  const clearConsole = (): void => {
    if (!id) return
    void window.api.browser.clearConsole(id).then(() => setEntries([]))
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // the native view has no idea the DOM moved, so re-send the rectangle whenever it changes.
    // a slow poll backs up the observers: it costs nothing and never leaves the view stranded.
    let last = ''
    const report = (): void => {
      // something is drawn over the app; a native view would cover it, so step aside
      if (overlaysOpen()) {
        if (last !== 'parked') {
          last = 'parked'
          window.api.browser.layout(null, null)
        }
        return
      }
      const r = el.getBoundingClientRect()
      const b = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.max(0, Math.round(r.width)),
        height: Math.max(0, Math.round(r.height))
      }
      const key = `${id}:${b.x},${b.y},${b.width},${b.height}`
      if (key === last) return
      last = key
      window.api.browser.layout(id, b)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    const poll = setInterval(report, 400)
    const offOverlay = onOverlayChange(report)
    window.addEventListener('scroll', report, true)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      clearInterval(poll)
      offOverlay()
      window.removeEventListener('scroll', report, true)
      window.removeEventListener('resize', report)
      window.api.browser.layout(null, null)
    }
  }, [id])

  useEffect(() => {
    if (!id) {
      setState(null)
      return
    }
    void window.api.browser.state(id).then((s) => {
      setState(s)
      if (s && !editing) setUrl(s.url === 'about:blank' ? '' : s.url)
    })
    const off = window.api.browser.onUpdate((sid, s) => {
      if (sid !== id) return
      setState(s)
      if (!editing) setUrl(s.url === 'about:blank' ? '' : s.url)
    })
    return off
  }, [id, editing])

  const errors = entries.filter((e) => e.level === '2').length

  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col bg-[var(--panel)]">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--line)] px-2">
        <NavButton label="←" title="back" disabled={!id || !state?.canGoBack} onClick={() => id && void window.api.browser.back(id)} />
        <NavButton
          label="→"
          title="forward"
          disabled={!id || !state?.canGoForward}
          onClick={() => id && void window.api.browser.forward(id)}
        />
        <NavButton
          label={state?.loading ? '✕' : '⟳'}
          title={state?.loading ? 'stop' : 'reload'}
          disabled={!id}
          onClick={() => id && void window.api.browser.reload(id)}
        />
        <input
          className="field min-w-0 flex-1"
          placeholder={id ? 'type a URL, e.g. localhost:3003' : 'browser is off for this session'}
          disabled={!id}
          value={url}
          spellCheck={false}
          onFocus={(e) => {
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setUrl(state?.url ?? '')
              e.currentTarget.blur()
            }
            if (e.key === 'Enter' && id && url.trim()) {
              void window.api.browser.navigate(id, url.trim())
              e.currentTarget.blur()
            }
          }}
        />
        <button
          onClick={() => id && void window.api.browser.newTab(id).then(() => readTabs())}
          disabled={!id}
          title="new tab"
          className="chip shrink-0 disabled:opacity-40"
        >
          +
        </button>
        <button
          onClick={() => id && void window.api.browser.devtools(id).then(setDevtools)}
          disabled={!id}
          title="the full Chromium inspector: elements, network, sources, console"
          className="chip shrink-0 disabled:opacity-40"
          style={devtools ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' } : undefined}
        >
          inspect
        </button>
        <button
          onClick={() => setConsoleOpen(!consoleOpen)}
          disabled={!id}
          title="what the page has logged"
          className="chip shrink-0 disabled:opacity-40"
          style={consoleOpen ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' } : undefined}
        >
          console{errors ? ` ${errors}` : ''}
        </button>
        <span className={`chip shrink-0 ${state?.loading ? 'chip-running' : 'chip-idle'}`}>{state?.loading ? 'loading' : 'browser'}</span>
      </div>
      {tabs.tabs.length > 1 && (
        <div className="flex shrink-0 items-stretch gap-px overflow-x-auto border-b border-[var(--line)] bg-[var(--ink)]">
          {tabs.tabs.map((t, i) => {
            const on = i === tabs.active
            return (
              <div
                key={i}
                className="group flex min-w-[90px] max-w-[190px] shrink-0 items-center gap-1 border-r border-[var(--line)] px-2 py-1"
                style={{
                  background: on ? 'var(--panel)' : 'transparent',
                  boxShadow: on ? 'inset 0 -2px 0 var(--accent)' : undefined
                }}
              >
                <button
                  onClick={() => id && void window.api.browser.selectTab(id, i).then(readTabs)}
                  title={t.url || 'new tab'}
                  className="min-w-0 flex-1 truncate text-left text-[10.5px]"
                  style={{ color: on ? 'var(--fg)' : 'var(--muted)' }}
                >
                  {t.loading ? '· ' : ''}
                  {t.title || hostOf(t.url) || 'new tab'}
                </button>
                <button
                  onClick={() => id && void window.api.browser.closeTab(id, i).then(readTabs)}
                  title="close this tab"
                  className="shrink-0 text-[10px] text-[var(--dim)] opacity-0 hover:text-[var(--danger)] group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      )}
      {/* The native view is laid out from this element's rectangle, so narrowing it is all the
          console panel has to do: no z-index can put anything over a native view. */}
      <div className="flex min-h-0 flex-1">
      <div ref={ref} className="min-h-0 min-w-0 flex-1">
        {!id && (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--dim)]">
            {agent ? 'browser is off for this agent' : 'only agents launched here get a browser'}
          </div>
        )}
      </div>
      {consoleOpen && id && <ConsolePanel entries={entries} onClear={clearConsole} />}
      </div>
    </div>
  )
}

const LEVEL: Record<string, { label: string; color: string }> = {
  '0': { label: 'log', color: 'var(--muted)' },
  '1': { label: 'warn', color: 'var(--warn)' },
  '2': { label: 'error', color: 'var(--danger)' },
  '3': { label: 'debug', color: 'var(--dim)' }
}

/**
 * What the page logged, in the app.
 *
 * The agent can already read this through its browser tools, which is how it debugs a page it is
 * driving; this is the same buffer for the person watching. Chromium reports levels as numbers, so
 * they are named here rather than shown raw.
 */
function ConsolePanel({ entries, onClear }: { entries: ConsoleEntry[]; onClear: () => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])
  return (
    <div className="flex w-[320px] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--ink)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-1">
        <span className="lbl">console</span>
        <span className="mono text-[10px] text-[var(--dim)]">{entries.length} line(s)</span>
        <button onClick={onClear} className="lbl ml-auto hover:!text-[var(--accent)]">
          clear
        </button>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto px-2 py-1">
        {!entries.length && (
          <div className="px-1 py-1 text-[11px] text-[var(--dim)]">nothing logged since this page loaded</div>
        )}
        {entries.map((e, i) => {
          const lv = LEVEL[e.level] ?? { label: e.level, color: 'var(--muted)' }
          return (
            <div key={i} className="mono border-b border-[var(--line)]/50 py-[3px] text-[10px] leading-snug last:border-b-0">
              <div className="flex items-baseline gap-2">
                <span className="shrink-0" style={{ color: lv.color }}>
                  {lv.label}
                </span>
                <span className="ml-auto shrink-0 text-[9px] text-[var(--dim)]">{e.at.slice(11, 19)}</span>
              </div>
              <div
                className="whitespace-pre-wrap break-words"
                style={{ color: lv.label === 'error' ? 'var(--danger)' : 'var(--muted)' }}
              >
                {e.text}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** `https://app.example.com/orders?x=1` is a tab called "app.example.com" when it has no title yet. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
