import type { Agent, Session } from '../../../shared/types'
import { age, clock, shortModel, tokens } from '../lib/format'
import { StateChip } from './Canvas'
import { Transcript } from '../workspace/Transcript'
import { Commands } from '../workspace/Commands'

interface Props {
  s: Session | null
  agent: Agent | null
  now: number
  onOpen: (id: string) => void
}

export function DetailPanel({ s, agent, now, onOpen }: Props): JSX.Element {
  if (!s) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--dim)]">
        hover a card for details · click to open it
      </div>
    )
  }
  const tok = s.tokens
  const toolCalls = s.transcript.filter((t) => t.kind === 'tool').length
  const exited = agent?.status === 'exited'
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--line)] px-4 py-3">
        <div className="lbl">session</div>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div className="text-[14px] font-semibold leading-tight">{s.topic ?? s.repo}</div>
          <StateChip state={exited ? 'exited' : s.state} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => onOpen(s.id)} className="chip chip-running hover:brightness-110">
            {agent ? (exited ? 'open · resume' : 'open terminal') : s.origin === 'subagent' ? 'open log' : 'open transcript'}
          </button>
          {agent && exited && (
            <button
              onClick={() => void window.api.removeAgent(agent.id)}
              title="drop this agent from the fleet; its transcript stays on disk"
              className="chip hover:!text-[var(--danger)]"
            >
              remove
            </button>
          )}
          {agent && !exited && (
            <button
              onClick={() => void window.api.stopAgent(agent.id)}
              title="end this agent's Claude process"
              className="chip hover:!text-[var(--danger)]"
            >
              stop
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-[var(--line)] px-4 py-3">
        <KV k="kind" v={s.origin === 'subagent' ? `subagent · ${s.agentType ?? 'agent'}` : s.origin === 'app' ? 'launched here' : 'from terminal'} />
        <KV k="repo" v={s.repo} />
        <KV k={s.worktree ? 'worktree' : 'branch'} v={s.worktree ?? s.branch ?? '—'} />
        <KV k="last command" v={s.lastCommand ?? '—'} />
        <KV k="model" v={shortModel(s.model)} />
        <KV k="tool calls" v={String(toolCalls)} />
        <KV k="turns" v={String(s.turns)} />
        <KV k="current" v={s.currentTool ?? (s.state === 'waiting' ? 'awaiting approval' : '—')} />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-[var(--line)] px-4 py-3">
        <KV k="input tokens" v={tokens(tok.input + tok.cacheRead + tok.cacheWrite)} />
        <KV k="output tokens" v={tokens(tok.output)} />
        <KV k="context now" v={s.context ? tokens(s.context) : '—'} />
        <KV k="last activity" v={age(s.lastEventAt, now)} />
        <KV k="started" v={s.firstEventAt ? clock(s.firstEventAt) : '—'} />
        <KV k="session id" v={s.id.slice(0, 8)} />
        <div className="col-span-2">
          <KV k="cwd" v={s.cwd} />
        </div>
      </div>
      {!!s.commands.length && <Commands list={s.commands} now={now} />}
      <div className="lbl px-4 pt-3">latest</div>
      <div className="min-h-0 flex-1">
        <Transcript items={s.transcript.slice(-60)} compact />
      </div>
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="lbl">{k}</div>
      <div className="mono mt-0.5 truncate text-[11px]" title={v}>
        {v}
      </div>
    </div>
  )
}
