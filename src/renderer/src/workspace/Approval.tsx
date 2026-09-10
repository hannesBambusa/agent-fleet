import { useEffect, useState } from 'react'
import { Screen, clean, delta, readOptions, walk } from './screen'

interface Prompt {
  question: string
  detail: string[]
  options: string[]
  cursor: number
}

/**
 * Claude Code draws its permission prompt in the terminal, so the only way to offer it in chat is to
 * read what the pty printed and pick the choices back out. Best effort by design: when the shape is
 * not recognised the chat falls back to sending you to the terminal, which always works.
 *
 * It reads the screen the pty has been replayed onto, not the buffer. Stripping the escapes and
 * splitting on newlines used to be enough; 2.1.x repaints single cells at absolute positions and
 * never ends a row, so the same buffer now flattens to one line and no prompt is ever found in it.
 */
export function readPrompt(lines: string[]): Prompt | null {
  const tail = lines.map(clean).slice(-60)
  const found = readOptions(tail)
  if (!found) return null
  const { options, cursor, at } = found

  const rule = (l: string): boolean => !l.trim() || /^[─—=_·.\s]+$/.test(l.trim())
  // The question is whatever sits above the choices, back to the top of the box it is drawn in.
  // Without that bound the lookback runs off the top of the box and into the conversation, and
  // quotes an older message that happened to end in a question mark.
  const top = Math.max(0, at - options.length)
  let from = Math.max(0, top - 8)
  for (let i = top; i >= from; i--) {
    if (rule(tail[i])) {
      from = i + 1
      break
    }
  }
  const text = tail.slice(from, top + 1).map((l) => l.trim()).filter((l) => l && !rule(l))
  const question = text.find((l) => /\?$/.test(l)) ?? text[text.length - 1] ?? 'Claude needs your approval'
  return { question, detail: text.filter((l) => l !== question).slice(-4), options, cursor }
}

export function ApprovalCard({
  agentId,
  onOpenTerminal,
  quiet
}: {
  agentId: string
  onOpenTerminal: () => void
  /** say nothing when the terminal holds no question: silence is the normal case */
  quiet?: boolean
}): JSX.Element | null {
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    let alive = true
    // the screen is kept and fed only what it has not seen; replaying the whole ring every tick
    // costs tens of milliseconds on the render thread, four times a second, for no new information
    let screen = new Screen()
    let seen = ''
    const load = (): void => {
      void window.api.pty.history(agentId).then((h) => {
        if (!alive) return
        const d = delta(seen, h)
        if (d.reset) screen = new Screen()
        screen.write(d.text)
        seen = h
        setPrompt(readPrompt(screen.lines()))
      })
    }
    load()
    const t = setInterval(load, 700)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [agentId])

  function choose(index: number): void {
    if (!prompt) return
    // the TUI moves a highlight, so walk it to the wanted row and press return
    for (const key of walk(prompt.cursor, index)) window.api.pty.write(agentId, key)
    setTimeout(() => window.api.pty.write(agentId, '\r'), 40)
    setSent(true)
    setTimeout(() => setSent(false), 2500)
  }

  if (!prompt) {
    if (quiet) return null
    return (
      <button
        onClick={onOpenTerminal}
        className="mb-4 flex w-full items-center gap-2 rounded-md border border-[var(--warn)]/40 bg-[var(--warn-soft)] px-3 py-2.5 text-left text-[11.5px] text-[var(--warn)] hover:brightness-110"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)] dot-blink" />
        Claude is waiting on something the chat cannot draw.
        <span className="ml-auto underline">open terminal</span>
      </button>
    )
  }

  return (
    <div className="mb-4 rounded-md border border-[var(--warn)]/40 bg-[var(--warn-soft)] px-3.5 py-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)] dot-blink" />
        <span className="lbl !text-[var(--warn)]">needs your approval</span>
        <button onClick={onOpenTerminal} className="lbl ml-auto underline hover:!text-[var(--fg)]">
          open terminal
        </button>
      </div>
      <div className="text-[12.5px] font-medium">{prompt.question}</div>
      {!!prompt.detail.length && (
        <div className="mono mt-1 space-y-0.5 text-[10.5px] text-[var(--muted)]">
          {prompt.detail.map((d, i) => (
            <div key={i} className="truncate" title={d}>
              {d}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {prompt.options.map((o, i) => (
          <button
            key={i}
            disabled={sent}
            onClick={() => choose(i)}
            className={`rounded border px-2.5 py-1 text-[11px] disabled:opacity-40 ${
              i === 0
                ? 'border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)] hover:brightness-110'
                : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--fg)]'
            }`}
          >
            {o}
          </button>
        ))}
      </div>
      {sent && <div className="mt-2 text-[10.5px] text-[var(--dim)]">sent · if nothing happens, answer it in the terminal</div>}
    </div>
  )
}
