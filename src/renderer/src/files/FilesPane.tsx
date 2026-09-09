import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirEntry, FileContents } from '../../../shared/types'
import { MonacoViewer } from './MonacoViewer'
import { Divider } from '../lib/Divider'
import { usePersisted } from '../state/persist'
import { onOpenFile } from '../state/openFile'

const TREE_MIN = 150
const TREE_MAX = 420
// below this the pane cannot hold both columns, so the tree becomes a step you walk back to
const SPLIT_AT = 620

function size(n: number): string {
  if (n < 1024) return `${n}b`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}

/**
 * A file browser for the folder an agent is working in.
 *
 * Two panes when there is room and one when there is not, rather than a second tab: a tree and the
 * file it opened are one activity, and splitting them across tabs means losing your place every time
 * you look at something. Narrow, the tree steps aside and a back arrow brings it back.
 */
export function FilesPane({ root, width }: { root: string; width: number }): JSX.Element {
  const [treeW, setTreeW] = usePersisted<number>('filesTreeWidth', 220)
  const from = useRef(0)
  const [open, setOpen] = useState<string | null>(null)
  const [file, setFile] = useState<FileContents | null>(null)
  const wide = width >= SPLIT_AT
  // narrow: the tree and the file take turns
  const showTree = wide || !open

  useEffect(() => {
    setOpen(null)
    setFile(null)
  }, [root])

  useEffect(() => onOpenFile(setOpen), [])

  useEffect(() => {
    if (!open) {
      setFile(null)
      return
    }
    let alive = true
    void window.api
      .files.readFile(open)
      .then((f) => alive && setFile(f))
      .catch(() => alive && setFile(null))
    return () => {
      alive = false
    }
  }, [open])

  return (
    <div className="flex h-full min-w-0">
      {showTree && (
        <div
          className="flex min-h-0 min-w-0 flex-col"
          style={wide ? { width: Math.min(treeW, Math.max(TREE_MIN, width - 260)) } : { flex: 1 }}
        >
          <Tree root={root} open={open} onOpen={setOpen} />
        </div>
      )}
      {wide && showTree && (
        <Divider
          onStart={() => (from.current = treeW)}
          onDrag={(d) => setTreeW(Math.min(TREE_MAX, Math.max(TREE_MIN, from.current + d)))}
          title="drag to resize the tree"
        />
      )}
      {(!showTree || wide) && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Viewer file={file} path={open} onBack={wide ? null : () => setOpen(null)} />
        </div>
      )}
    </div>
  )
}

interface Node {
  entry: DirEntry
  depth: number
}

/** The tree, flattened: only expanded directories contribute their children. */
function Tree({ root, open, onOpen }: { root: string; open: string | null; onOpen: (p: string) => void }): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]))
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [q, setQ] = useState('')

  const load = useCallback((dir: string) => {
    void window.api.files.listDir(dir).then((list) => setChildren((c) => ({ ...c, [dir]: list })))
  }, [])

  useEffect(() => {
    setExpanded(new Set([root]))
    setChildren({})
    load(root)
  }, [root, load])

  const nodes = useMemo(() => {
    const out: Node[] = []
    const walk = (dir: string, depth: number): void => {
      for (const entry of children[dir] ?? []) {
        // a filter searches what is loaded rather than the disk, which is what makes it instant
        const hit = !q || entry.name.toLowerCase().includes(q.toLowerCase())
        if (hit) out.push({ entry, depth })
        if (entry.dir && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk(root, 0)
    return out
  }, [children, expanded, root, q])

  function toggle(entry: DirEntry): void {
    if (!entry.dir) {
      onOpen(entry.path)
      return
    }
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else {
        next.add(entry.path)
        if (!children[entry.path]) load(entry.path)
      }
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-[var(--line)]">
      <div className="shrink-0 border-b border-[var(--line)] px-2 py-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter open folders…"
          className="w-full rounded border border-[var(--line)] bg-[var(--ink)] px-2 py-1 text-[11px] outline-none focus:border-[var(--accent)]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {nodes.map(({ entry, depth }) => {
          const on = entry.path === open
          return (
            <button
              key={entry.path}
              onClick={() => toggle(entry)}
              style={{ paddingLeft: 6 + depth * 11 }}
              title={entry.name}
              className={`flex w-full items-center gap-1 py-[3px] pr-2 text-left hover:bg-[var(--raised)] ${
                on ? 'bg-[var(--raised)] shadow-[inset_2px_0_0_var(--accent)]' : ''
              }`}
            >
              <span className="w-2.5 shrink-0 text-[9px] text-[var(--dim)]">
                {entry.dir ? (expanded.has(entry.path) ? '▾' : '▸') : ''}
              </span>
              <span
                className={`mono min-w-0 flex-1 truncate text-[11px] ${
                  entry.dir ? 'text-[var(--fg)]' : on ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
                }`}
              >
                {entry.name}
              </span>
              {!entry.dir && <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{size(entry.size)}</span>}
            </button>
          )
        })}
        {!nodes.length && <div className="px-3 py-2 text-[11px] text-[var(--dim)]">nothing here</div>}
      </div>
    </div>
  )
}

/** The file itself, coloured by the same tokenizer the chat diffs use. */
function Viewer({
  file,
  path,
  onBack
}: {
  file: FileContents | null
  path: string | null
  onBack: (() => void) | null
}): JSX.Element {
  const lines = useMemo(() => (file && !file.binary ? file.text.split('\n').length : 0), [file])

  if (!path) {
    return <div className="flex h-full items-center justify-center text-[11px] text-[var(--dim)]">pick a file</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-2 py-1.5">
        {onBack && (
          <button onClick={onBack} className="lbl shrink-0 hover:!text-[var(--accent)]">
            ← files
          </button>
        )}
        <span className="mono min-w-0 flex-1 truncate text-[11px]" title={path}>
          {path.split('/').pop()}
        </span>
        {file && !file.binary && <span className="lbl shrink-0">{lines} lines</span>}
        <button onClick={() => void window.api.shell.openPath(path)} className="lbl shrink-0 hover:!text-[var(--accent)]">
          open outside
        </button>
      </div>
      {!file ? (
        <div className="flex h-full items-center justify-center text-[11px] text-[var(--dim)]">reading…</div>
      ) : file.error ? (
        <div className="px-3 py-2 text-[11px] text-[var(--danger)]">{file.error}</div>
      ) : file.binary ? (
        <div className="px-3 py-2 text-[11px] text-[var(--dim)]">
          not text · {size(file.size)} · open it outside the app to look at it
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MonacoViewer path={path} text={file.text} />
        </div>
      )}
      {file?.truncated && (
        <div className="lbl shrink-0 border-t border-[var(--line)] px-3 py-1.5">
          longer than 1 MB · showing the first part
        </div>
      )}
    </div>
  )
}
