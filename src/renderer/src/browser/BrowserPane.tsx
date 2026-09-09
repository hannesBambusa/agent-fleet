import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Agent, BrowserState } from '../../../shared/types'
import { onOverlayChange, overlaysOpen } from '../state/overlay'

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
        <span className={`chip shrink-0 ${state?.loading ? 'chip-running' : 'chip-idle'}`}>{state?.loading ? 'loading' : 'browser'}</span>
      </div>
      <div ref={ref} className="min-h-0 flex-1">
        {!id && (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--dim)]">
            {agent ? 'browser is off for this agent' : 'only agents launched here get a browser'}
          </div>
        )}
      </div>
    </div>
  )
}
