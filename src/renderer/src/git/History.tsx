import { useEffect, useMemo, useState } from 'react'
import type { GitCommit, GitCommitDetail } from '../../../shared/types'
import { age } from '../lib/format'
import { DiffView } from './DiffView'
import { layout, refBadges, type Row } from './graph'

// one row, and the lane spacing the rail is drawn on
const ROW = 24
const LANE = 13

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
    // every ref, not just this branch: the point of a graph is seeing the other branches
    void window.api.gitGraph(cwd, 200).then(setList).catch(() => setList([]))
  }, [cwd])

  useEffect(() => {
    if (!sha) return
    setFile(null)
    setDiff('')
    void window.api.gitCommit(cwd, sha).then(setDetail).catch(() => setDetail(null))
  }, [cwd, sha])

  const { rows, width } = useMemo(() => layout(list ?? []), [list])

  useEffect(() => {
    if (!sha || !file) return
    void window.api.gitDiff(cwd, file, false, false, undefined, sha).then(setDiff).catch(() => setDiff(''))
  }, [cwd, sha, file])

  if (!list) return <Center>reading history…</Center>
  if (!list.length) return <Center>no commits yet</Center>

  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[45%] shrink-0 overflow-auto border-b border-[var(--line)]">
        {rows.map((r) => (
          <GraphRow
            key={r.commit.sha}
            row={r}
            width={width}
            selected={r.commit.sha === sha}
            onPick={() => setSha(r.commit.sha === sha ? null : r.commit.sha)}
          />
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

/**
 * One commit, with the piece of the graph that passes through its row.
 *
 * The rail is drawn per row rather than as one tall SVG so the list stays a plain scrolling column:
 * lines that continue are straight, lines that change lane bend halfway down, which is what makes a
 * merge read as a merge.
 */
function GraphRow({
  row,
  width,
  selected,
  onPick
}: {
  row: Row
  width: number
  selected: boolean
  onPick: () => void
}): JSX.Element {
  const x = (lane: number): number => lane * LANE + LANE / 2
  const mid = ROW / 2
  const badges = refBadges(row.commit.refs)
  return (
    <button
      onClick={onPick}
      style={{ height: ROW }}
      className={`flex w-full items-center gap-2 pr-3 text-left hover:bg-[var(--raised)] ${
        selected ? 'bg-[var(--raised)] shadow-[inset_2px_0_0_var(--accent)]' : ''
      }`}
    >
      <svg width={width * LANE + 8} height={ROW} className="shrink-0" style={{ marginLeft: 4 }} aria-hidden>
        {row.links.map((l, i) =>
          l.straight ? (
            <line key={i} x1={x(l.from)} y1={0} x2={x(l.from)} y2={ROW} stroke={l.color} strokeWidth={1.5} />
          ) : (
            <path
              key={i}
              d={`M ${x(l.from)} 0 C ${x(l.from)} ${mid}, ${x(l.to)} ${mid}, ${x(l.to)} ${ROW}`}
              fill="none"
              stroke={l.color}
              strokeWidth={1.5}
            />
          )
        )}
        {row.up && <line x1={x(row.lane)} y1={0} x2={x(row.lane)} y2={mid} stroke={row.color} strokeWidth={1.5} />}
        {row.down && <line x1={x(row.lane)} y1={mid} x2={x(row.lane)} y2={ROW} stroke={row.color} strokeWidth={1.5} />}
        <circle
          cx={x(row.lane)}
          cy={mid}
          r={4}
          fill={row.commit.parents.length > 1 ? 'var(--panel)' : row.color}
          stroke={row.color}
          strokeWidth={2}
        />
      </svg>
      <span className="min-w-0 flex-1 truncate text-[11px]" title={row.commit.subject}>
        {row.commit.subject}
      </span>
      {badges.slice(0, 3).map((b) => (
        <span
          key={b.label}
          title={b.label}
          className="mono shrink-0 rounded-full px-1.5 py-[1px] text-[9px]"
          style={
            b.kind === 'head'
              ? { background: 'var(--accent)', color: 'var(--ink)' }
              : b.kind === 'remote'
                ? { background: 'color-mix(in srgb, var(--sub) 22%, transparent)', color: 'var(--sub)' }
                : { background: 'var(--raised)', color: 'var(--muted)' }
          }
        >
          {b.label.replace(/^origin\//, '↑')}
        </span>
      ))}
      <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{age(row.commit.at)}</span>
    </button>
  )
}

export function Center({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--dim)]">{children}</div>
}
