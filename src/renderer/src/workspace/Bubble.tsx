import type { TranscriptEdit, TranscriptItem } from '../../../shared/types'
import { clock } from '../lib/format'
import { Markdown } from './Markdown'
import { ToolLine } from './ToolLine'
import type { Turn } from './turns'

export function Bubble({
  t,
  agentId,
  cwd,
  openTools
}: {
  t: Turn
  agentId: string | null
  cwd: string
  openTools: boolean
}): JSX.Element {
  if (t.role === 'you') {
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-[var(--accent-soft)] px-3.5 py-2.5">
          <div className="mono mb-1 text-[9px] uppercase tracking-widest text-[var(--accent)]">you · {clock(t.ts)}</div>
          {t.command ? (
            <div className="mono text-[12px] text-[var(--fg)]">{t.text}</div>
          ) : (
            <div className="select text-[12.5px] leading-relaxed">
              <Markdown text={t.text} agentId={agentId} cwd={cwd} />
            </div>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="mb-4 max-w-[92%]">
      <div className="mono mb-1 text-[9px] uppercase tracking-widest text-[var(--dim)]">claude · {clock(t.ts)}</div>
      {t.text && (
        <div className="select text-[12.5px] leading-relaxed text-[var(--fg)]/90">
          <Markdown text={t.text} agentId={agentId} cwd={cwd} />
        </div>
      )}
      {t.tools.map((tool) => (
        <ToolLine key={tool.id} tool={tool} startOpen={openTools} />
      ))}
    </div>
  )
}

/**
 * What kind of thing a tool call is, for the eye rather than the parser.
 *
 * A turn is a column of near-identical grey rows, and the three that matter read differently: a
 * command that ran, a file that changed, a page the agent touched. Each gets an edge colour and a
 * glyph, and nothing else moves, so the rows still scan as one list.
 */
