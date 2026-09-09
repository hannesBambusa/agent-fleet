import { dur, tokens as fmtTokens } from '../lib/format'
import { useCountUp } from '../lib/useCountUp'

export function Working({
  tool,
  elapsed,
  produced,
  verb,
  waiting,
  sub,
  onInterrupt
}: {
  tool: string | null
  elapsed: number
  produced: number
  verb: string
  waiting: boolean
  sub: boolean
  onInterrupt?: () => void
}): JSX.Element {
  const color = waiting ? 'var(--warn)' : sub ? 'var(--sub)' : 'var(--accent)'
  const shown = useCountUp(produced)
  return (
    <div>
      <div className="flex items-center gap-2 text-[11.5px]" style={{ color }}>
      <span className={waiting ? 'dot-blink' : 'node-breathe'} style={{ fontSize: 13 }}>
        ✶
      </span>
      <span>{waiting ? 'Waiting for your approval' : `${verb}…`}</span>
      <span className="mono text-[10px] text-[var(--dim)]">
        ({dur(elapsed)}
        {shown > 0 ? ` · ↓ ${fmtTokens(shown)} tokens` : ''})
      </span>
      {tool && !waiting && <span className="mono text-[10px] text-[var(--muted)]">{tool}</span>}
        {!waiting && (
          <span className="flex gap-[3px]">
            <Dot delay={0} />
            <Dot delay={0.18} />
            <Dot delay={0.36} />
          </span>
        )}
        {onInterrupt && (
          <button
            onClick={onInterrupt}
            title="interrupt this turn (esc)"
            className="mono ml-auto rounded border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--danger)]/50 hover:text-[var(--danger)]"
          >
            interrupt · esc
          </button>
        )}
      </div>
      <div
        className={`work-track mt-2 h-[3px] w-full rounded-full ${
          waiting ? 'work-track-wait' : sub ? 'work-track-sub' : ''
        }`}
      />
    </div>
  )
}

function Dot({ delay }: { delay: number }): JSX.Element {
  return (
    <span
      className="node-breathe inline-block h-[3px] w-[3px] rounded-full bg-current"
      style={{ animationDelay: `${delay}s`, animationDuration: '1.2s' }}
    />
  )
}
