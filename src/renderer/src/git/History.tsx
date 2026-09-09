import { useEffect, useState } from 'react'
import type { GitCommit, GitCommitDetail } from '../../../shared/types'
import { age } from '../lib/format'
import { DiffView } from './DiffView'

const letterColor: Record<string, string> = {
  M: 'text-[#e0af68]',
  A: 'text-[#8bf0bd]',
  D: 'text-[#ff9b93]',
  R: 'text-[#7aa2f7]'
}

export function History({ cwd }: { cwd: string }): JSX.Element {
  const [list, setList] = useState<GitCommit[] | null>(null)
  const [sha, setSha] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')

  useEffect(() => {
    setSha(null)
    setDetail(null)
    setFile(null)
    void window.api.gitLog(cwd).then(setList).catch(() => setList([]))
  }, [cwd])

  useEffect(() => {
    if (!sha) return
    setFile(null)
    setDiff('')
    void window.api.gitCommit(cwd, sha).then(setDetail).catch(() => setDetail(null))
  }, [cwd, sha])

  useEffect(() => {
    if (!sha || !file) return
    void window.api.gitDiff(cwd, file, false, false, undefined, sha).then(setDiff).catch(() => setDiff(''))
  }, [cwd, sha, file])

  if (!list) return <Center>reading history…</Center>
  if (!list.length) return <Center>no commits on this branch yet</Center>

  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[45%] shrink-0 overflow-auto border-b border-[var(--line)]">
        {list.map((c) => (
          <button
            key={c.sha}
            onClick={() => setSha(c.sha === sha ? null : c.sha)}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-[var(--raised)] ${
              c.sha === sha ? 'bg-[var(--raised)] shadow-[inset_2px_0_0_var(--accent)]' : ''
            }`}
          >
            <span className="mono shrink-0 text-[10px] text-[var(--accent)]">{c.sha}</span>
            <span className="min-w-0 flex-1 truncate text-[11px]" title={c.subject}>
              {c.subject}
            </span>
            {c.refs.slice(0, 2).map((r) => (
              <span key={r} className="lbl shrink-0 rounded bg-[var(--raised)] px-1 py-0.5" title={r}>
                {r.replace('HEAD -> ', '')}
              </span>
            ))}
            <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{age(c.at)}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {!detail ? (
          <Center>pick a commit</Center>
        ) : file ? (
          <div className="flex h-full flex-col">
            <button onClick={() => setFile(null)} className="lbl shrink-0 border-b border-[var(--line)] px-3 py-1.5 text-left hover:!text-[var(--fg)]">
              ← back to {detail.short}
            </button>
            <div className="min-h-0 flex-1">
              <DiffView diff={diff} path={file} />
            </div>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <div className="border-b border-[var(--line)] px-3 py-2.5">
              <div className="text-[12px] font-medium">{detail.subject}</div>
              {detail.body && <div className="mono mt-1 whitespace-pre-wrap text-[10.5px] text-[var(--muted)]">{detail.body}</div>}
              <div className="mono mt-1.5 text-[9.5px] text-[var(--dim)]">
                {detail.short} · {detail.author} · {new Date(detail.at).toLocaleString()}
              </div>
              {detail.stat && <div className="mono mt-1 text-[9.5px] text-[var(--muted)]">{detail.stat}</div>}
            </div>
            <div className="lbl px-3 py-1.5">files {detail.files.length}</div>
            {detail.files.map((f) => (
              <button
                key={f.path}
                onClick={() => setFile(f.path)}
                className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-[var(--raised)]"
              >
                <span className="mono min-w-0 flex-1 truncate text-[11px]">{f.path}</span>
                <span className={`mono shrink-0 text-[10px] ${letterColor[f.letter] ?? 'text-[var(--muted)]'}`}>{f.letter}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function Center({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--dim)]">{children}</div>
}
