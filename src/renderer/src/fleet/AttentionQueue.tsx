import { useEffect, useRef, useState } from 'react'
import type { AttentionItem, AttentionSettings } from '../../../shared/types'
import { age } from '../lib/format'
import { useOverlay } from '../state/overlay'

/**
 * The one thing you must not miss, in one place.
 *
 * Running many agents only works if you can stop watching them, and two moments need a person: one
 * is blocked on an approval, one has finished. Both raise a system notification and land here, so
 * the answer to "is anything waiting on me" is a glance rather than a tour of the fleet.
 */
export function AttentionQueue({ onOpen }: { onOpen: (sessionId: string) => void }): JSX.Element | null {
  const [items, setItems] = useState<AttentionItem[]>([])
  const [prefs, setPrefs] = useState<AttentionSettings | null>(null)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const box = useRef<HTMLDivElement>(null)
  useOverlay(open)

  useEffect(() => {
    void window.api.attention.list().then(setItems)
    void window.api.attention.prefs().then(setPrefs)
    const off = window.api.attention.onUpdate(setItems)
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

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

  const waiting = items.filter((i) => i.kind === 'waiting')
  const done = items.filter((i) => i.kind === 'done')

  function take(item: AttentionItem): void {
    onOpen(item.sessionId)
    void window.api.attention.dismiss(item.id)
    setOpen(false)
  }

  function toggle(key: keyof AttentionSettings): void {
    if (!prefs) return
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    void window.api.attention.setPrefs({ [key]: next[key] })
  }

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={items.length ? `${items.length} thing(s) want you` : 'nothing is waiting on you'}
        className="flex items-center gap-1.5 rounded border px-2 py-1 text-[11px]"
        style={
          waiting.length
            ? { borderColor: 'color-mix(in srgb, var(--warn) 55%, transparent)', color: 'var(--warn)' }
            : items.length
              ? { borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)', color: 'var(--accent)' }
              : { borderColor: 'var(--line)', color: 'var(--dim)' }
        }
      >
        <span className={waiting.length ? 'dot-blink' : ''}>●</span>
        {items.length ? items.length : 'clear'}
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[340px] overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)] shadow-2xl">
          <div className="lbl flex items-baseline justify-between border-b border-[var(--line)] px-3 py-2">
            <span>needs you</span>
            {!!items.length && (
              <button onClick={() => void window.api.attention.clear()} className="lbl hover:!text-[var(--accent)]">
                clear all
              </button>
            )}
          </div>

          <div className="max-h-[300px] overflow-auto">
            {!items.length && (
              <div className="px-3 py-3 text-[11px] text-[var(--dim)]">
                nothing is waiting on you. Approvals and finished turns land here.
              </div>
            )}
            {[...waiting, ...done].map((i) => (
              <button
                key={i.id}
                onClick={() => take(i)}
                className="flex w-full items-baseline gap-2 border-b border-[var(--line)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--raised)]"
              >
                <span
                  className={`mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full ${i.kind === 'waiting' ? 'dot-blink' : ''}`}
                  style={{ background: i.kind === 'waiting' ? 'var(--warn)' : 'var(--accent)' }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px]">{i.title}</span>
                  <span className="mono block truncate text-[9.5px] text-[var(--dim)]">
                    {i.repo} · {i.kind === 'waiting' ? 'wants approval' : 'finished'}
                  </span>
                </span>
                <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{age(i.at, now)}</span>
              </button>
            ))}
          </div>

          {prefs && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--line)] px-3 py-2">
              <Check on={prefs.onWaiting} onClick={() => toggle('onWaiting')}>
                approvals
              </Check>
              <Check on={prefs.onDone} onClick={() => toggle('onDone')}>
                finished
              </Check>
              <Check on={prefs.appAgentsOnly} onClick={() => toggle('appAgentsOnly')}>
                only agents from here
              </Check>
              <Check on={prefs.sound} onClick={() => toggle('sound')}>
                sound
              </Check>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Check({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button onClick={onClick} className="flex items-center gap-1" role="switch" aria-checked={on}>
      <span
        className="flex h-[11px] w-[11px] items-center justify-center rounded-[3px] border text-[8px]"
        style={
          on
            ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--ink)' }
            : { borderColor: 'var(--line)', color: 'transparent' }
        }
      >
        ✓
      </span>
      <span className="lbl">{children}</span>
    </button>
  )
}
