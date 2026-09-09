import { memo, useMemo, useState, useEffect } from 'react'
import type { TranscriptEdit, TranscriptItem } from '../../../shared/types'
import { annotate, collapse, lineDiff, summarise } from '../lib/lineDiff'
import { highlight, langOf, type Token } from '../lib/highlight'

function kindOf(tool: string): { tone: string; glyph: string; label: string } {
  if (tool.startsWith('mcp__')) {
    // mcp__browser__browser_click reads as "browser · click"
    const [, server = 'mcp', ...rest] = tool.split('__')
    const action = rest.join('__').replace(new RegExp(`^${server}_`), '')
    return { tone: 'var(--sub)', glyph: '◈', label: `${server} · ${action}` }
  }
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell') {
    // a block cursor: a terminal without borrowing `$`, which reads as a shell variable next to code
    return { tone: 'var(--warn)', glyph: '▮', label: tool }
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return { tone: 'var(--accent)', glyph: '✎', label: tool }
  }
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'WebFetch' || tool === 'WebSearch') {
    return { tone: 'var(--code-fn)', glyph: '◇', label: tool }
  }
  if (tool === 'Task' || tool === 'Agent') return { tone: 'var(--sub)', glyph: '⌥', label: tool }
  return { tone: 'var(--muted)', glyph: '·', label: tool }
}

export function ToolLine({
  tool,
  startOpen
}: {
  tool: { tool: string; text: string; result?: TranscriptItem; edit?: TranscriptEdit }
  startOpen: boolean
}): JSX.Element {
  const [open, setOpen] = useState(startOpen)
  // flipping the default re-opens or closes every row, including ones already touched by hand
  useEffect(() => {
    setOpen(startOpen)
  }, [startOpen])
  const err = tool.result?.isError
  const kind = kindOf(tool.tool)
  // a file edit is what actually happened; its output is usually just "ok"
  const rows = useMemo(
    () => (tool.edit ? annotate(collapse(lineDiff(tool.edit.before, tool.edit.after)), tool.edit.line) : null),
    [tool.edit]
  )
  const lang = tool.edit ? langOf(tool.edit.path) : ''
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(!open)}
        style={{ borderLeft: `2px solid ${err ? 'var(--danger)' : kind.tone}` }}
        className="mono flex w-full items-baseline gap-2 rounded border border-[var(--line)] bg-[var(--panel)] py-1 pl-1.5 pr-2 text-left text-[10.5px] hover:border-[var(--muted)]"
      >
        <span className="shrink-0" style={{ color: err ? 'var(--danger)' : kind.tone }}>
          {open ? '▾' : '▸'} <span className="opacity-80">{kind.glyph}</span> {kind.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]" title={tool.text}>
          {tool.text}
        </span>
        {rows && !open && (
          <span className="mono shrink-0 text-[9.5px]">
            <span style={{ color: 'var(--diff-add-ink)' }}>+{rows.filter((r) => r.kind === 'add').length}</span>{' '}
            <span style={{ color: 'var(--diff-del-ink)' }}>-{rows.filter((r) => r.kind === 'del').length}</span>
          </span>
        )}
        {!tool.result && <span className="shrink-0 text-[var(--accent)]">running</span>}
      </button>
      {open && rows && (
        <div className="select mt-1 overflow-hidden rounded border border-[var(--line)] bg-[var(--panel)]">
          {/* the same header Claude Code prints: what it did, to which file, in how many lines */}
          <div className="flex items-baseline gap-2 border-b border-[var(--line)] px-2 py-1">
            <span className="mono text-[10.5px] text-[var(--fg)]">
              {tool.tool === 'Write' ? 'Write' : 'Update'}({tool.edit?.path.split('/').slice(-2).join('/')})
            </span>
            <span className="mono text-[10px] text-[var(--dim)]">{summarise(rows)}</span>
          </div>
          <div className="max-h-[340px] overflow-auto py-1 text-[10px] leading-[1.55]">
            {rows.map((r, i) => (
              <div
                key={i}
                className="mono flex whitespace-pre-wrap break-words px-1"
                style={
                  r.kind === 'add'
                    ? { background: 'var(--diff-add-bg)' }
                    : r.kind === 'del'
                      ? { background: 'var(--diff-del-bg)' }
                      : undefined
                }
              >
                <span className="w-8 shrink-0 select-none pr-1 text-right text-[var(--dim)] opacity-70">{r.n ?? ''}</span>
                <span
                  className="w-3 shrink-0 select-none"
                  style={{
                    color: r.kind === 'add' ? 'var(--diff-add-ink)' : r.kind === 'del' ? 'var(--diff-del-ink)' : 'transparent'
                  }}
                >
                  {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
                </span>
                {/* the diff says which lines moved, the syntax colours say what the code is; the two
                    are drawn separately so a changed line still reads as code */}
                <span className="min-w-0 flex-1">
                  {r.parts
                    ? r.parts.map((p, k) => (
                        <span
                          key={k}
                          style={
                            p.changed
                              ? {
                                  background: r.kind === 'add' ? 'var(--diff-add-word)' : 'var(--diff-del-word)',
                                  borderRadius: '2px'
                                }
                              : undefined
                          }
                        >
                          <Code text={p.text} lang={lang} />
                        </span>
                      ))
                    : r.text
                      ? <Code text={r.text} lang={lang} />
                      : ' '}
                </span>
              </div>
            ))}
            {!!tool.edit?.more && (
              <div className="lbl px-2 pt-1">and {tool.edit.more} more edit(s) in the same call</div>
            )}
          </div>
        </div>
      )}
      {open && !rows && tool.result && (
        <pre className="select mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-[10px] leading-snug text-[var(--muted)]">
          {tool.result.text || '(no output)'}
        </pre>
      )}
    </div>
  )
}

const TOKEN_COLOR: Record<Token['kind'], string | undefined> = {
  comment: 'var(--code-comment)',
  string: 'var(--code-string)',
  number: 'var(--code-number)',
  keyword: 'var(--code-keyword)',
  fn: 'var(--code-fn)',
  punct: 'var(--code-punct)',
  // an identifier keeps the pane's own text colour, which is what makes the rest read as colour
  plain: 'var(--fg)'
}

/** One line of code, coloured. Memoised: a long diff would otherwise re-tokenise on every tick. */
const Code = memo(function Code({ text, lang }: { text: string; lang: string }): JSX.Element {
  return (
    <>
      {highlight(text, lang).map((t, i) => (
        <span key={i} style={{ color: TOKEN_COLOR[t.kind] }}>
          {t.text}
        </span>
      ))}
    </>
  )
})
