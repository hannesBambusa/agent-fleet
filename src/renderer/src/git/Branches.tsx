import { useEffect, useState } from 'react'
import type { GitBranch } from '../../../shared/types'
import { age } from '../lib/format'
import { Center } from './History'

export function Branches({ cwd }: { cwd: string }): JSX.Element {
  const [list, setList] = useState<GitBranch[] | null>(null)
  useEffect(() => {
    void window.api.gitBranches(cwd).then(setList).catch(() => setList([]))
  }, [cwd])

  if (!list) return <Center>reading branches…</Center>
  if (!list.length) return <Center>no branches</Center>

  return (
    <div className="h-full overflow-auto">
      {list.map((b) => (
        <div
          key={b.name}
          className={`flex items-baseline gap-2 border-b border-[var(--line)] px-3 py-2 ${b.current ? 'bg-[var(--raised)]' : ''}`}
        >
          <span
            className="mono shrink-0 text-[11px]"
            style={{ color: b.current ? 'var(--accent)' : 'var(--fg)' }}
            title={b.current ? 'checked out here' : undefined}
          >
            {b.current ? '● ' : ''}
            {b.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--muted)]" title={b.subject}>
            {b.subject}
          </span>
          {(b.ahead > 0 || b.behind > 0) && (
            <span className="mono shrink-0 text-[9.5px]">
              {b.ahead > 0 && <span className="text-[#8bf0bd]">↑{b.ahead}</span>}
              {b.behind > 0 && <span className="ml-1 text-[#ff9b93]">↓{b.behind}</span>}
            </span>
          )}
          <span className="mono shrink-0 text-[9px] text-[var(--dim)]" title={b.upstream ?? 'no upstream'}>
            {b.upstream ? 'tracked' : 'local'} · {age(b.at)}
          </span>
        </div>
      ))}
    </div>
  )
}
