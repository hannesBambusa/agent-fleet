import { useEffect, useRef, useState } from 'react'
import { THEMES, type Theme } from '../state/theme'
import { useOverlay } from '../state/overlay'

export function ThemeMenu({ theme, onPick }: { theme: Theme; onPick: (id: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useOverlay(open)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="theme"
        className="flex items-center gap-1.5 rounded border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--fg)]"
      >
        <Swatch t={theme} />
        {theme.name}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[190px] overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)] shadow-2xl">
          <div className="lbl border-b border-[var(--line)] px-3 py-2">theme</div>
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                onPick(t.id)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11.5px] hover:bg-[var(--raised)] ${
                t.id === theme.id ? 'bg-[var(--raised)]' : ''
              }`}
            >
              <Swatch t={t} />
              <span className="flex-1">{t.name}</span>
              <span className="lbl">{t.dark ? 'dark' : 'light'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Swatch({ t }: { t: Theme }): JSX.Element {
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 overflow-hidden rounded-full border border-black/20" title={t.name}>
      <span className="h-full w-1/2" style={{ background: t.vars.ink }} />
      <span className="h-full w-1/2" style={{ background: t.vars.accent }} />
    </span>
  )
}
