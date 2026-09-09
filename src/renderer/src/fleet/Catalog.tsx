import { useEffect, useMemo, useState } from 'react'
import type { CatalogItem, CatalogKind } from '../../../shared/types'
import { normalise, toggleQuick, useQuick } from '../state/quickCommands'

const SOURCE_TONE: Record<CatalogItem['source'], { label: string; color: string }> = {
  user: { label: 'yours', color: 'var(--accent)' },
  plugin: { label: 'plugin', color: 'var(--sub)' },
  project: { label: 'project', color: 'var(--warn)' }
}

/**
 * What Claude Code can do here, read off disk: skills, slash commands, subagent definitions.
 *
 * The point is knowing what you already have. These accumulate across three places — your own
 * config, installed plugins, each project — and nothing lists them together, so the same skill gets
 * written twice and a command sits unused because nobody remembers it exists.
 */
export function Catalog({ kind }: { kind: CatalogKind }): JSX.Element {
  const quick = useQuick()
  const [all, setAll] = useState<CatalogItem[] | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    void window.api
      .catalog()
      .then(setAll)
      .catch(() => setAll([]))
  }, [])

  useEffect(() => {
    setQ('')
    setOpen(null)
  }, [kind])

  const list = useMemo(() => {
    const mine = (all ?? []).filter((i) => i.kind === kind)
    const needle = q.trim().toLowerCase()
    if (!needle) return mine
    return mine.filter((i) => `${i.name} ${i.description} ${i.origin}`.toLowerCase().includes(needle))
  }, [all, kind, q])

  const groups = useMemo(() => {
    const map = new Map<string, CatalogItem[]>()
    for (const i of list) {
      const key = i.source === 'user' ? 'yours' : `${i.source} · ${i.origin}`
      map.set(key, [...(map.get(key) ?? []), i])
    }
    // your own first, then plugins, then projects, each alphabetically
    return [...map.entries()].sort((a, b) => (a[0] === 'yours' ? -1 : b[0] === 'yours' ? 1 : a[0].localeCompare(b[0])))
  }, [list])

  if (!all) {
    return <div className="flex h-full items-center justify-center text-[12px] text-[var(--dim)]">reading ~/.claude…</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`filter ${kind}s…`}
          className="w-[240px] rounded border border-[var(--line)] bg-[var(--ink)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--accent)]"
        />
        <span className="lbl">
          {list.length} {kind}
          {list.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {!list.length && <div className="text-[11px] text-[var(--dim)]">nothing matches</div>}
        {groups.map(([group, items]) => (
          <div key={group} className="mb-5">
            <div className="lbl mb-1.5 flex items-baseline gap-2">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: SOURCE_TONE[items[0].source].color }}
                aria-hidden
              />
              {group}
              <span className="text-[var(--dim)]">{items.length}</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
              {items.map((i) => (
                <Card
                  key={i.path}
                  item={i}
                  open={open === i.path}
                  pinned={quick.includes(normalise(i.name))}
                  onToggle={() => setOpen(open === i.path ? null : i.path)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Card({
  item,
  open,
  pinned,
  onToggle
}: {
  item: CatalogItem
  open: boolean
  pinned: boolean
  onToggle: () => void
}): JSX.Element {
  const tone = SOURCE_TONE[item.source]
  return (
    <div
      className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 transition-colors hover:border-[var(--accent)]/40"
      style={open ? { borderColor: `color-mix(in srgb, ${tone.color} 55%, transparent)` } : undefined}
    >
      <button onClick={onToggle} className="flex w-full items-baseline gap-2 text-left">
        <span className="mono min-w-0 flex-1 truncate text-[12px]" style={{ color: tone.color }}>
          {item.kind === 'command' ? `/${item.name}` : item.name}
        </span>
        {pinned && (
          <span className="lbl shrink-0" style={{ color: 'var(--accent)' }} title="has a quick button above the chat composer">
            quick
          </span>
        )}
        {item.model && <span className="lbl shrink-0">{item.model}</span>}
        {item.userOnly && (
          <span className="lbl shrink-0" title="reachable only when you type it; the model cannot pick it">
            manual
          </span>
        )}
      </button>
      <p className={`mt-1 text-[11px] leading-snug text-[var(--muted)] ${open ? '' : 'line-clamp-2'}`}>
        {item.description || <span className="text-[var(--dim)]">no description</span>}
      </p>
      {open && (
        <div className="mt-2 flex flex-col gap-1 border-t border-[var(--line)] pt-2">
          {item.hint && <Row k="takes" v={item.hint} />}
          {item.tools && <Row k="tools" v={item.tools} />}
          <Row k="file" v={item.path.replace(/^\/Users\/[^/]+/, '~')} />
          <div className="mt-1 flex gap-2">
            {item.kind === 'command' && (
              <button
                onClick={() => toggleQuick(item.name)}
                title={
                  pinned
                    ? 'remove this quick button from above the chat composer'
                    : 'add a one-click button for this above the chat composer'
                }
                className={`chip ${pinned ? 'chip-running' : ''} hover:!text-[var(--accent)]`}
              >
                {pinned ? 'remove quick button' : 'add as quick button'}
              </button>
            )}
            <button onClick={() => void window.api.openPath(item.path)} className="chip hover:!text-[var(--accent)]">
              open file
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="lbl w-[42px] shrink-0">{k}</span>
      <span className="mono min-w-0 flex-1 break-all text-[10px] text-[var(--muted)]">{v}</span>
    </div>
  )
}
