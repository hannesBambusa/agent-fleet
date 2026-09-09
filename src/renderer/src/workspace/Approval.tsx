import { useEffect, useState } from 'react'

interface Prompt {
  question: string
  detail: string[]
  options: string[]
  cursor: number
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g
const OPTION = /^\s*(❯|>)?\s*(\d+)[.)]\s+(.+?)\s*$/
// Claude Code draws the prompt inside a box, so every line arrives wrapped in border glyphs
const BORDER_L = /^[\s│┃|╭╰├┌└]+/
const BORDER_R = /[\s│┃|╮╯┤┐┘]+$/

function clean(line: string): string {
  return line.replace(BORDER_L, '').replace(BORDER_R, '')
}

/**
 * Claude Code draws its permission prompt in the terminal, so the only way to offer it in chat is to
 * read what the pty printed and pick the choices back out. Best effort by design: when the shape is
 * not recognised the chat falls back to sending you to the terminal, which always works.
 */
export function parsePrompt(raw: string): Prompt | null {
  const lines = raw
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(clean)
  const tail = lines.slice(-60)

  const options: string[] = []
  let cursor = 0
  let lastOptionAt = -1
  for (let i = 0; i < tail.length; i++) {
    const m = OPTION.exec(tail[i])
    if (!m) continue
    const index = Number(m[2])
    // options restart at 1; a later block replaces an earlier one
    if (index === 1) {
      options.length = 0
      cursor = 0
    }
    if (index !== options.length + 1) continue
    if (m[1]) cursor = options.length
    options.push(m[3].replace(/\s*\(esc\)\s*$/i, ''))
    lastOptionAt = i
  }
  if (options.length < 2 || lastOptionAt === -1) {
    const bare = bareSelect(tail)
    if (!bare) return null
    options.length = 0
    options.push(...bare.options)
    cursor = bare.cursor
    lastOptionAt = bare.at
  }

  const above = tail.slice(Math.max(0, lastOptionAt - options.length - 8), lastOptionAt - options.length + 1)
  const text = above.map((l) => l.trim()).filter((l) => l && !/^[─—=_·.\s]+$/.test(l))
  const question = text.find((l) => /\?$/.test(l)) ?? text[text.length - 1] ?? 'Claude needs your approval'
  return { question, detail: text.filter((l) => l !== question).slice(-4), options, cursor }
}

/**
 * Some prompts, the workspace trust dialog among them, list their choices without numbers. They are
 * recognised by the highlight marker plus a short run of terse lines around it.
 */
function bareSelect(tail: string[]): { options: string[]; cursor: number; at: number } | null {
  const marker = tail.map((l, i) => ({ l, i })).filter(({ l }) => /^❯\s+\S/.test(l)).pop()
  if (!marker) return null
  const terse = (l: string): boolean => !!l && l.length < 70 && !/[.:]$/.test(l)
  const options = [marker.l.replace(/^❯\s+/, '')]
  let at = marker.i
  for (let i = marker.i + 1; i < tail.length && options.length < 5; i++) {
    const line = tail[i].trim()
    if (!line) break
    if (!terse(line)) break
    options.push(line)
    at = i
  }
  return options.length >= 2 ? { options, cursor: 0, at } : null
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
    const load = (): void => {
      void window.api.pty.history(agentId).then((h) => {
        if (alive) setPrompt(parsePrompt(h))
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
    const steps = index - prompt.cursor
    const key = steps > 0 ? '\x1b[B' : '\x1b[A'
    for (let i = 0; i < Math.abs(steps); i++) window.api.pty.write(agentId, key)
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
