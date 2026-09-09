import { useState } from 'react'
import type { SessionCommand } from '../../../shared/types'
import { age, clock, dur } from '../lib/format'

/**
 * Every slash command this session was given, newest first.
 *
 * The commands are the shape of how a session was worked: /git-add, /preflight, /fix-issues,
 * /commit. Read back in order they say what was tried and how long each round took, which no other
 * view shows — the transcript is a ring and forgets, and the chat buries them between answers.
 */
export function Commands({ list, now }: { list: SessionCommand[]; now: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const newestFirst = [...list].reverse()
  const shown = open ? newestFirst : newestFirst.slice(0, 6)
  return (
    <div className="border-b border-[var(--line)] px-4 py-3">
      <div className="lbl mb-1.5 flex items-baseline justify-between">
        <span>commands · {list.length}</span>
        {list.length > 6 && (
          <button onClick={() => setOpen(!open)} className="lbl hover:!text-[var(--accent)]">
            {open ? 'show less ▴' : `all ${list.length} ▾`}
          </button>
        )}
      </div>
      <ol className="relative">
        {shown.map((c, i) => {
          // the gap to the command before it, which is how long that round of work took
          const prev = newestFirst[i + 1]
          const took = prev ? Date.parse(c.at) - Date.parse(prev.at) : 0
          return (
            <li key={`${c.at}-${i}`} className="relative flex items-baseline gap-2 pb-1.5 pl-4">
              {i < shown.length - 1 && (
                <span className="absolute left-[3px] top-[9px] h-full w-px bg-[var(--line)]" aria-hidden />
              )}
              <span
                className="absolute left-0 top-[5px] h-[7px] w-[7px] rounded-full"
                style={{ background: i === 0 ? 'var(--accent)' : 'var(--dim)' }}
                aria-hidden
              />
              <span className="mono min-w-0 flex-1 truncate text-[11px]" title={c.name}>
                {c.name}
              </span>
              <span className="mono shrink-0 text-[9.5px] text-[var(--dim)]" title={new Date(c.at).toLocaleString()}>
                {clock(c.at)}
              </span>
              <span className="mono w-[42px] shrink-0 text-right text-[9px] text-[var(--dim)]">
                {i === 0 ? age(c.at, now) : took > 1000 ? `+${dur(took)}` : ''}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
