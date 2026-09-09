import { useMemo, useState } from 'react'
import type { Session, UsageLimit, UsageSnapshot } from '../../../shared/types'
import { dur, tokens } from '../lib/format'

// fixed order, validated against the app's dark surface for colour-vision separation
const SERIES = [
  { key: 'input', label: 'fresh input', color: '#3987e5' },
  { key: 'output', label: 'output', color: '#d95926' },
  { key: 'cacheRead', label: 'cache read', color: '#199e70' },
  { key: 'cacheWrite', label: 'cache write', color: '#9085e9' }
] as const

type Key = (typeof SERIES)[number]['key']

interface Row {
  id: string
  label: string
  sub: string
  parts: Record<Key, number>
  total: number
}

function rowOf(s: Session): Row {
  const parts = {
    input: s.tokens.input,
    output: s.tokens.output,
    cacheRead: s.tokens.cacheRead,
    cacheWrite: s.tokens.cacheWrite
  }
  return {
    id: s.id,
    label: s.topic ?? s.lastPrompt?.split('\n')[0]?.slice(0, 40) ?? s.repo,
    sub: s.origin === 'subagent' ? `subagent · ${s.agentType ?? 'agent'}` : s.repo,
    parts,
    total: parts.input + parts.output + parts.cacheRead + parts.cacheWrite
  }
}

function group(sessions: Session[], by: (s: Session) => string | null): Row[] {
  const map = new Map<string, Row>()
  for (const s of sessions) {
    const key = by(s)
    if (!key) continue
    const r = map.get(key) ?? { id: key, label: key, sub: '', parts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, total: 0 }
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as Key[]) r.parts[k] += s.tokens[k]
    r.total = r.parts.input + r.parts.output + r.parts.cacheRead + r.parts.cacheWrite
    map.set(key, r)
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

export function FleetUsage({
  sessions,
  snap,
  onOpen
}: {
  sessions: Session[]
  snap: UsageSnapshot | null
  onOpen: (id: string) => void
}): JSX.Element {
  const [asTable, setAsTable] = useState(false)
  const used = useMemo(() => sessions.filter((s) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite > 0), [sessions])

  const totals = useMemo(() => {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const s of used) for (const k of Object.keys(t) as Key[]) t[k] += s.tokens[k]
    return { ...t, all: t.input + t.output + t.cacheRead + t.cacheWrite }
  }, [used])

  const bySession = useMemo(() => used.map(rowOf).sort((a, b) => b.total - a.total).slice(0, 14), [used])
  const byRepo = useMemo(() => group(used, (s) => s.repo), [used])
  const byModel = useMemo(() => group(used, (s) => (s.model ? s.model.replace(/^claude-/, '') : null)), [used])

  // plan limits and lifetime stats are worth showing even before any session has spent a token
  if (!used.length && !snap?.limits.length && !snap?.stats) {
    return <div className="flex h-full items-center justify-center text-[12px] text-[var(--dim)]">no usage recorded yet</div>
  }

  const cached = totals.cacheRead
  const billedIn = totals.input + totals.cacheWrite
  const hitRate = cached + billedIn ? Math.round((cached / (cached + billedIn)) * 100) : 0

  const stats = snap?.stats
  return (
    <div className="h-full overflow-auto px-5 py-4">
      {!!snap?.limits.length && (
        <div className="mb-6">
          <div className="lbl mb-2 flex items-baseline justify-between">
            <span>plan limits</span>
            <span title={snap.live ? 'read from the live status-line payload' : 'cached by Claude Code in ~/.claude.json'}>
              {snap.fetchedAt ? `${snap.live ? 'live' : 'cached'} · ${dur(Date.now() - snap.fetchedAt)} ago` : ''}
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3">
            {snap.limits.map((l) => (
              <Meter key={l.key} l={l} />
            ))}
          </div>
        </div>
      )}

      {!!used.length && (
      <>
      <div className="lbl mb-2">sessions on this machine, last 3 days</div>
      <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px overflow-hidden rounded border border-[var(--line)] bg-[var(--line)]">
        <Tile k="total tokens" v={tokens(totals.all)} sub={`${used.length} sessions`} />
        <Tile k="output" v={tokens(totals.output)} sub="what the models wrote" />
        <Tile k="read from cache" v={tokens(totals.cacheRead)} sub={`${hitRate}% of context reused`} />
        <Tile k="written to cache" v={tokens(totals.cacheWrite)} sub="context stored for reuse" />
      </div>

      <div className="mb-3 flex items-center justify-between">
        <Legend />
        <button onClick={() => setAsTable(!asTable)} className="lbl rounded px-1.5 py-0.5 hover:!text-[var(--fg)]">
          {asTable ? 'chart' : 'table'}
        </button>
      </div>

      {asTable ? (
        <Table rows={bySession} />
      ) : (
        <>
          <Chart title="by session" rows={bySession} onPick={onOpen} />
          <Chart title="by repo" rows={byRepo} />
          <Chart title="by model" rows={byModel} />
        </>
      )}
      </>
      )}

      {stats && (
        <>
          <div className="lbl mb-2 mt-2">all time, from Claude Code's own stats</div>
          <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px overflow-hidden rounded border border-[var(--line)] bg-[var(--line)]">
            <Tile k="sessions" v={stats.totalSessions.toLocaleString()} sub="since first run" />
            <Tile k="messages" v={stats.totalMessages.toLocaleString()} sub="turns exchanged" />
            <Tile k="tool calls" v={stats.totalToolCalls.toLocaleString()} sub="last 90 days" />
            <Tile
              k="first session"
              v={stats.firstSessionDate ? stats.firstSessionDate.slice(0, 10) : '—'}
              sub={stats.models.length ? `${stats.models.length} models used` : ''}
            />
          </div>
          <Activity daily={stats.daily} />
        </>
      )}
    </div>
  )
}

// status colours, reserved for state and never reused as a series colour
function severityColor(l: UsageLimit): string {
  if (l.severity === 'critical' || l.percent >= 95) return '#e34948'
  if (l.severity === 'warning' || l.percent >= 80) return '#eda100'
  return '#199e70'
}

function until(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  return ms > 0 ? `resets in ${dur(ms)}` : 'resetting'
}

function Meter({ l }: { l: UsageLimit }): JSX.Element {
  const color = severityColor(l)
  return (
    <div className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] font-medium">
          {l.label}
          {l.kind === 'weekly_scoped' && <span className="ml-1.5 text-[9px] text-[var(--dim)]">weekly</span>}
        </span>
        <span className="mono text-[13px]" style={{ color }}>
          {l.percent}%
        </span>
      </div>
      <div className="mt-2 h-[8px] w-full overflow-hidden rounded-[4px] bg-[var(--raised)]">
        <div className="h-full rounded-[4px]" style={{ width: `${Math.max(l.percent, 1.5)}%`, background: color }} />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[9.5px] text-[var(--dim)]">
        <span>{until(l.resetsAt)}</span>
        {l.percent >= 95 && <span style={{ color }}>exhausted</span>}
      </div>
    </div>
  )
}

function Activity({ daily }: { daily: Array<{ date: string; messages: number; sessions: number; toolCalls: number }> }): JSX.Element | null {
  if (!daily.length) return null
  const max = Math.max(...daily.map((d) => d.messages), 1)
  return (
    <div className="mb-4">
      <div className="lbl mb-2">daily messages · last {daily.length} days</div>
      <div className="flex h-[64px] items-end gap-[3px]">
        {daily.map((d) => (
          <span
            key={d.date}
            title={`${d.date} · ${d.messages} messages · ${d.sessions} sessions · ${d.toolCalls} tool calls`}
            className="flex-1 rounded-t-[3px] bg-[var(--accent)]"
            style={{ height: `${Math.max(2, (d.messages / max) * 100)}%`, opacity: 0.75 }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-[var(--dim)]">
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
    </div>
  )
}

function Tile({ k, v, sub }: { k: string; v: string; sub: string }): JSX.Element {
  return (
    <div className="bg-[var(--panel)] px-4 py-3">
      <div className="lbl">{k}</div>
      <div className="mono mt-1 text-[18px] leading-none">{v}</div>
      <div className="mt-1.5 text-[10px] text-[var(--dim)]">{sub}</div>
    </div>
  )
}

function Legend(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {SERIES.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

function Chart({ title, rows, onPick }: { title: string; rows: Row[]; onPick?: (id: string) => void }): JSX.Element | null {
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => r.total), 1)
  return (
    <div className="mb-6">
      <div className="lbl mb-2">{title}</div>
      <div className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <div
            key={r.id}
            className={onPick ? 'cursor-pointer' : undefined}
            onClick={onPick ? () => onPick(r.id) : undefined}
          >
            <div className="mb-1 flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px]" title={r.label}>
                {r.label}
              </span>
              {r.sub && <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{r.sub}</span>}
              <span className="mono shrink-0 text-[10px] text-[var(--muted)]">{tokens(r.total)}</span>
            </div>
            <div className="flex h-[14px] w-full items-stretch gap-[2px]">
              {SERIES.map((s) => {
                const v = r.parts[s.key]
                if (!v) return null
                const w = (v / max) * 100
                return (
                  <span
                    key={s.key}
                    title={`${s.label}: ${tokens(v)} · ${Math.round((v / r.total) * 100)}% of ${r.label}`}
                    className="rounded-[4px]"
                    style={{ width: `${w}%`, background: s.color, minWidth: 2 }}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Table({ rows }: { rows: Row[] }): JSX.Element {
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead>
        <tr className="border-b border-[var(--line)]">
          <th className="lbl py-1.5 text-left">session</th>
          {SERIES.map((s) => (
            <th key={s.key} className="lbl py-1.5 text-right">
              {s.label}
            </th>
          ))}
          <th className="lbl py-1.5 text-right">total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-[var(--line)]">
            <td className="max-w-[280px] truncate py-1.5 pr-3">{r.label}</td>
            {SERIES.map((s) => (
              <td key={s.key} className="mono py-1.5 text-right text-[var(--muted)]">
                {tokens(r.parts[s.key])}
              </td>
            ))}
            <td className="mono py-1.5 text-right">{tokens(r.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
