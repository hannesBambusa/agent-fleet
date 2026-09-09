import { useEffect, useRef, useState } from 'react'
import type { TranscriptItem } from '../../../shared/types'
import { clock } from '../lib/format'

export function Transcript({ items, compact = false }: { items: TranscriptItem[]; compact?: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [items, stick])
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
      }}
      className={`select h-full overflow-auto py-3 leading-relaxed ${compact ? 'px-4 text-[11px]' : 'px-5 text-[12.5px]'}`}
    >
      {items.map((it) => (
        <Row key={it.id} it={it} />
      ))}
    </div>
  )
}

function Row({ it }: { it: TranscriptItem }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const time = <span className="mr-3 shrink-0 font-mono text-[10px] text-[var(--dim)]">{clock(it.ts)}</span>
  switch (it.kind) {
    case 'prompt':
      return (
        <div className="my-3 flex">
          {time}
          <div className="rounded-md border-l-2 border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 whitespace-pre-wrap">{it.text}</div>
        </div>
      )
    case 'command':
      return (
        <div className="my-2 flex items-center">
          {time}
          <span className="rounded bg-[var(--raised)] px-2 py-0.5 font-mono text-[11px] text-[var(--fg)]">{it.text}</span>
        </div>
      )
    case 'text':
      return (
        <div className="my-2 flex">
          {time}
          <div className="whitespace-pre-wrap text-[var(--fg)]/90">{it.text}</div>
        </div>
      )
    case 'tool':
      return (
        <div className="my-1 flex items-start">
          {time}
          <button onClick={() => setOpen(!open)} className="flex min-w-0 items-start gap-2 text-left font-mono text-[11px]">
            <span className="shrink-0 text-[var(--accent)]">▸ {it.tool}</span>
            <span className={`text-[var(--muted)] ${open ? 'whitespace-pre-wrap' : 'truncate'}`}>{it.text}</span>
          </button>
        </div>
      )
    case 'result':
      if (!it.text.trim()) return null
      return (
        <div className="my-1 flex items-start">
          {time}
          <button
            onClick={() => setOpen(!open)}
            className={`min-w-0 text-left font-mono text-[11px] ${it.isError ? 'text-[var(--danger)]' : 'text-[var(--dim)]'}`}
          >
            <span className={open ? 'whitespace-pre-wrap' : 'line-clamp-1'}>{open ? it.text : it.text.split('\n')[0]}</span>
          </button>
        </div>
      )
    default:
      return null
  }
}
