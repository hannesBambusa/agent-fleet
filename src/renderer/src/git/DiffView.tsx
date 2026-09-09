import { useMemo } from 'react'

type Kind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

interface Line {
  kind: Kind
  text: string
  old: number | null
  now: number | null
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// unified diff → numbered lines, so the pane can render it like an editor gutter
function parse(diff: string): Line[] {
  const out: Line[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      continue
    }
    const h = HUNK.exec(raw)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      out.push({ kind: 'hunk', text: raw, old: null, now: null })
      continue
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), old: null, now: newNo++ })
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), old: oldNo++, now: null })
    else if (raw.startsWith('\\')) out.push({ kind: 'meta', text: raw, old: null, now: null })
    else out.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, now: newNo++ })
  }
  while (out.length && out[out.length - 1].kind === 'ctx' && !out[out.length - 1].text) out.pop()
  return out
}

const bg: Record<Kind, string> = {
  add: 'bg-[rgba(94,224,160,0.10)]',
  del: 'bg-[rgba(242,104,92,0.10)]',
  ctx: '',
  hunk: 'bg-[var(--raised)]',
  meta: ''
}
const fg: Record<Kind, string> = {
  add: 'text-[#8bf0bd]',
  del: 'text-[#ff9b93]',
  ctx: 'text-[var(--fg)]/75',
  hunk: 'text-[var(--muted)]',
  meta: 'text-[var(--dim)]'
}

export function DiffView({ diff, path }: { diff: string; path: string }): JSX.Element {
  const lines = useMemo(() => parse(diff), [diff])
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length

  if (!diff.trim()) {
    return <div className="flex h-full items-center justify-center text-[11px] text-[var(--dim)]">no textual changes in {path}</div>
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-3 py-1.5">
        <span className="mono truncate text-[11px]" title={path}>
          {path}
        </span>
        <span className="mono ml-auto shrink-0 text-[10px]">
          <span className="text-[#8bf0bd]">+{added}</span> <span className="text-[#ff9b93]">−{removed}</span>
        </span>
      </div>
      <div className="select min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={bg[l.kind]}>
                <td className="mono w-[38px] select-none border-r border-[var(--line)] px-1.5 text-right align-top text-[9.5px] leading-[1.55] text-[var(--dim)]">
                  {l.old ?? ''}
                </td>
                <td className="mono w-[38px] select-none border-r border-[var(--line)] px-1.5 text-right align-top text-[9.5px] leading-[1.55] text-[var(--dim)]">
                  {l.now ?? ''}
                </td>
                <td className={`mono w-[14px] select-none text-center align-top text-[10px] leading-[1.55] ${fg[l.kind]}`}>
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                </td>
                <td className={`mono whitespace-pre-wrap break-all px-1 align-top text-[10.5px] leading-[1.55] ${fg[l.kind]}`}>
                  {l.text || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
