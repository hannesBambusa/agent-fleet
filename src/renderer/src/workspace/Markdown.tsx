import { Children, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openLink } from '../state/openLink'
import { openFile, resolvePath, splitPaths } from '../state/openFile'

/**
 * Claude writes markdown, so the chat renders markdown. Everything is styled from the app's tokens
 * rather than a stylesheet, and long paths and code are allowed to wrap instead of stretching the
 * pane, since a chat column is narrow and full of absolute paths.
 */
/**
 * Turns the file paths inside a piece of text into links to the app's own viewer.
 *
 * Claude names files constantly, and following one meant reading the path and finding it in an
 * editor. Only strings are rewritten: anything react-markdown already turned into an element (a
 * link, a code span) is left exactly as it was.
 */
function withPaths(children: React.ReactNode, cwd: string): React.ReactNode {
  if (!cwd) return children
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child
    const pieces = splitPaths(child)
    if (pieces.length === 1 && !pieces[0].path) return child
    return pieces.map((p, i) =>
      p.path ? <FileLink key={i} path={p.text} cwd={cwd} /> : <span key={i}>{p.text}</span>
    )
  })
}

function FileLink({ path, cwd }: { path: string; cwd: string }): JSX.Element {
  return (
    <button
      onClick={() => openFile(resolvePath(path, cwd, window.api.home))}
      title={`open ${path} in the file browser`}
      className="mono cursor-pointer rounded bg-[var(--raised)] px-1 py-[1px] text-[0.92em] text-[var(--accent)] underline decoration-[var(--accent)]/30 hover:decoration-[var(--accent)]"
    >
      {path}
    </button>
  )
}

export const Markdown = memo(function Markdown({
  text,
  agentId,
  cwd = ''
}: {
  text: string
  agentId?: string | null
  cwd?: string
}): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{withPaths(children, cwd)}</p>,
        strong: ({ children }) => <strong className="font-semibold text-[var(--fg)]">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ children, href }) => (
          <a
            href={href}
            title={href}
            // the agent has a browser of its own, and that is where its links belong; holding a
            // modifier sends it out to the system browser instead
            onClick={(e) => {
              e.preventDefault()
              if (!href) return
              if (e.metaKey || e.shiftKey) void window.api.shell.openExternal(href)
              else openLink(href, agentId ?? null)
            }}
            className="cursor-pointer text-[var(--accent)] underline decoration-[var(--accent)]/40 hover:decoration-[var(--accent)]"
          >
            {children}
          </a>
        ),
        h1: ({ children }) => <h1 className="mb-2 mt-3 text-[14px] font-semibold first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-3 text-[13px] font-semibold first:mt-0">{children}</h2>,
        h3: ({ children }) => (
          <h3 className="lbl mb-1.5 mt-3 !text-[var(--muted)] first:mt-0">{children}</h3>
        ),
        ul: ({ children }) => <ul className="mb-2 ml-1 list-none space-y-1 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 ml-5 list-decimal space-y-1 last:mb-0 marker:text-[var(--dim)]">{children}</ol>,
        li: ({ children, ...props }) => {
          const ordered = 'index' in props
          return (
            <li className={ordered ? 'pl-1 leading-relaxed' : 'relative pl-4 leading-relaxed'}>
              {!ordered && <span className="absolute left-0 top-[0.62em] h-[3px] w-[3px] rounded-full bg-[var(--dim)]" />}
              {withPaths(children, cwd)}
            </li>
          )
        },
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-[var(--line)] pl-3 text-[var(--muted)]">{children}</blockquote>
        ),
        hr: () => <hr className="my-3 border-[var(--line)]" />,
        code: ({ children, className }) => {
          const block = /language-/.test(className ?? '')
          if (!block) {
            // a path in backticks is the most common way one is written; make that one a link too
            const only = Children.toArray(children)
            const text = typeof only[0] === 'string' && only.length === 1 ? only[0] : ''
            const pieces = text ? splitPaths(text) : []
            if (cwd && pieces.length === 1 && pieces[0].path) return <FileLink path={text} cwd={cwd} />
            return (
              <code className="mono rounded bg-[var(--raised)] px-1 py-[1px] text-[0.92em] text-[var(--fg)]">{children}</code>
            )
          }
          return <code className="mono block">{children}</code>
        },
        pre: ({ children }) => (
          <pre className="select mb-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-[10.5px] leading-snug">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="mb-2 overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="border-b border-[var(--line)]">{children}</thead>,
        th: ({ children }) => <th className="lbl py-1 pr-3 text-left align-top">{children}</th>,
        td: ({ children }) => <td className="border-b border-[var(--line)] py-1 pr-3 align-top">{children}</td>
      }}
    >
      {text}
    </ReactMarkdown>
  )
})
