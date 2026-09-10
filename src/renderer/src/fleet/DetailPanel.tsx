import { useState } from 'react'
import type { Agent, Session } from '../../../shared/types'
import { age, clock, shortModel, tokens } from '../lib/format'
import { StateChip } from './Canvas'
import { Transcript } from '../workspace/Transcript'
import { Commands } from '../workspace/Commands'
import { RemoveDialog } from './RemoveDialog'

interface Props {
  s: Session | null
  agent: Agent | null
  now: number
  onOpen: (id: string) => void
}

export function DetailPanel({ s, agent, now, onOpen }: Props): JSX.Element {
  const [removing, setRemoving] = useState(false)
  const [naming, setNaming] = useState(false)
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
          {naming ? (
            <Naming s={s} onDone={() => setNaming(false)} />
          ) : (
            <button
              onClick={() => setNaming(true)}
              title="name this session, and say what it is about"
              className="group min-w-0 flex-1 text-left"
            >
              <div className="truncate text-[14px] font-semibold leading-tight">
                {s.topic ?? s.repo}
                <span className="lbl ml-2 opacity-0 transition-opacity group-hover:opacity-100">rename</span>
              </div>
              {s.note && <div className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">{s.note}</div>}
            </button>
          )}
          <StateChip state={exited ? 'exited' : s.state} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => onOpen(s.id)} className="chip chip-running hover:brightness-110">
            {agent ? (exited ? 'open · resume' : 'open terminal') : s.origin === 'subagent' ? 'open log' : 'open transcript'}
          </button>
          {agent && exited && (
            <button
              onClick={() => setRemoving(true)}
              title="remove this agent, its conversation and its worktree"
              className="chip hover:!text-[var(--danger)]"
            >
              remove
            </button>
          )}
          {agent && !exited && (
            <button
              onClick={() => void window.api.agents.stopAgent(agent.id)}
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
      {removing && agent && (
        <RemoveDialog
          agentId={agent.id}
          title={s.topic ?? s.repo}
          onClose={() => setRemoving(false)}
          onDone={() => undefined}
        />
      )}
      <div className="lbl px-4 pt-3">latest</div>
      <div className="min-h-0 flex-1">
        <Transcript items={s.transcript.slice(-60)} compact />
      </div>
    </div>
  )
}

/**
 * Naming a session, and saying what it is for.
 *
 * Claude Code names a session from the work, which is a good guess and sometimes the wrong one: two
 * agents in one repo end up with titles that read alike, and a session that changed direction keeps
 * the name of what it started as. What you type wins, here and in the terminal status line, which
 * reads the same topic file.
 */
function Naming({ s, onDone }: { s: Session; onDone: () => void }): JSX.Element {
  const [name, setName] = useState(s.topic ?? '')
  const [note, setNote] = useState(s.note ?? '')
  const save = (): void => {
    void window.api.sessions.setLabel(s.id, { name, note }).then(onDone)
  }
  return (
    <div className="min-w-0 flex-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') onDone()
        }}
        placeholder="what to call this agent"
        className="w-full rounded border border-[var(--line)] bg-[var(--ink)] px-2 py-1 text-[13px] font-semibold outline-none focus:border-[var(--accent)]"
      />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          if (e.key === 'Escape') onDone()
        }}
        rows={2}
        placeholder="what this session is about"
        className="mt-1 w-full resize-none rounded border border-[var(--line)] bg-[var(--ink)] px-2 py-1 text-[11px] outline-none focus:border-[var(--accent)]"
      />
      <div className="mt-1 flex items-center gap-2">
        <span className="lbl">↵ save · esc cancel</span>
        <button onClick={onDone} className="chip ml-auto hover:!text-[var(--fg)]">
          cancel
        </button>
        <button onClick={save} className="chip chip-running hover:brightness-110">
          save
        </button>
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
