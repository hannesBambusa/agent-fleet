import { useEffect, useMemo, useState } from 'react'
import type { McpServer, Session } from '../../../shared/types'
import { age } from '../lib/format'
import { openFile } from '../state/openFile'

const SCOPE_TONE: Record<McpServer['scope'], string> = {
  user: 'var(--accent)',
  project: 'var(--warn)',
  plugin: 'var(--sub)',
  'claude.ai': 'var(--code-fn)',
  app: 'var(--accent)',
  // a server nothing here configured, found because a session called it
  'in use': 'var(--sub)'
}

interface Use {
  calls: number
  last: string | null
  sessions: Set<string>
  live: boolean
}

/**
 * The MCP servers Claude Code can reach, and what is actually using them.
 *
 * Nothing on disk says whether a server is connected right now: that state lives inside a running
 * Claude Code process. What can be said honestly is which sessions have called its tools and when,
 * which is the question behind "is it connected" anyway. A server nobody has called is shown as
 * configured rather than dead, because it may simply not have been needed yet.
 */
function usage(sessions: Session[]): Map<string, Use> {
  const out = new Map<string, Use>()
  for (const s of sessions) {
    for (const item of s.transcript) {
      if (item.kind !== 'tool' || !item.tool?.startsWith('mcp__')) continue
      const server = item.tool.split('__')[1]
      if (!server) continue
      const u = out.get(server) ?? { calls: 0, last: null, sessions: new Set<string>(), live: false }
      u.calls++
      if (!u.last || item.ts > u.last) u.last = item.ts
      u.sessions.add(s.id)
      if (s.state === 'running' || s.state === 'waiting') u.live = true
      out.set(server, u)
    }
  }
  return out
}

/** The app's own server is named `browser`, and its calls arrive as mcp__browser__*. */
function keyFor(s: McpServer): string {
  return s.name.toLowerCase().replace(/\s+/g, '-')
}

export function McpPane({ sessions, now }: { sessions: Session[]; now: number }): JSX.Element {
  const [list, setList] = useState<McpServer[] | null>(null)
  useEffect(() => {
    void window.api
      .catalog.mcpServers()
      .then(setList)
      .catch(() => setList([]))
  }, [])

  const used = useMemo(() => usage(sessions), [sessions])

  /**
   * Not every server reachable from Claude Code is written down here. The Claude in Chrome extension
   * registers itself, and an agent can be launched with `--mcp-config` that never touches a config
   * file. Those exist only in the record of what they were asked to do, so the tab lists them from
   * that rather than pretending they are not there.
   */
  const full = useMemo(() => {
    if (!list) return null
    const known = new Set(list.map(keyFor))
    const extra: McpServer[] = [...used.keys()]
      .filter((k) => !known.has(k))
      .map((name) => ({
        name,
        scope: 'in use' as const,
        origin: 'discovered',
        transport: 'managed' as const,
        command: null,
        url: null,
        enabled: true,
        path: null
      }))
    return [...list, ...extra]
  }, [list, used])

  if (!full) {
    return <div className="flex h-full items-center justify-center text-[12px] text-[var(--dim)]">reading config…</div>
  }

  const groups = [...new Set(full.map((s) => s.scope))]

  return (
    <div className="h-full overflow-auto px-4 py-3">
      <p className="mb-3 max-w-[560px] text-[11px] leading-snug text-[var(--dim)]">
        Whether a server is connected lives inside a running Claude Code process, not on disk. These
        are the servers it can reach, with the sessions that have actually called them.
      </p>
      {groups.map((scope) => (
        <div key={scope} className="mb-5">
          <div className="lbl mb-1.5 flex items-baseline gap-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: SCOPE_TONE[scope] }} aria-hidden />
            {scope}
            <span className="text-[var(--dim)]">{full.filter((s) => s.scope === scope).length}</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
            {full
              .filter((s) => s.scope === scope)
              .map((s) => {
                const u = used.get(keyFor(s))
                return (
                  <div
                    key={`${s.scope}:${s.origin}:${s.name}`}
                    className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2"
                    style={u?.live ? { borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' } : undefined}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="mono min-w-0 flex-1 truncate text-[12px]" style={{ color: SCOPE_TONE[s.scope] }}>
                        {s.name}
                      </span>
                      {!s.enabled && <span className="lbl shrink-0 !text-[var(--danger)]">disabled</span>}
                      <span className="lbl shrink-0">{s.transport}</span>
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      {u ? (
                        <>
                          <span
                            className={`h-[6px] w-[6px] shrink-0 rounded-full ${u.live ? 'dot-blink' : ''}`}
                            style={{ background: u.live ? 'var(--accent)' : 'var(--muted)' }}
                            aria-hidden
                          />
                          <span className="text-[11px] text-[var(--muted)]">
                            {u.live ? 'in use now' : 'used'} · {u.calls} call{u.calls === 1 ? '' : 's'} ·{' '}
                            {u.sessions.size} session{u.sessions.size === 1 ? '' : 's'}
                          </span>
                          {u.last && <span className="mono ml-auto text-[9px] text-[var(--dim)]">{age(u.last, now)}</span>}
                        </>
                      ) : (
                        <>
                          <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--dim)]" aria-hidden />
                          <span className="text-[11px] text-[var(--dim)]">configured, not called in any live session</span>
                        </>
                      )}
                    </div>
                    {(s.command || s.url) && (
                      <div className="mono mt-1.5 break-all text-[9.5px] text-[var(--dim)]">{s.command ?? s.url}</div>
                    )}
                    {s.scope === 'in use' && (
                      <div className="mono mt-1.5 text-[9.5px] text-[var(--dim)]">
                        not in any config file here; registered by whatever launched it
                      </div>
                    )}
                    {s.path && (
                      <button
                        onClick={() => openFile(s.path!)}
                        className="chip mt-1.5 hover:!text-[var(--accent)]"
                      >
                        open config
                      </button>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      ))}
      {!full.length && <div className="text-[11px] text-[var(--dim)]">no MCP servers configured</div>}
    </div>
  )
}
