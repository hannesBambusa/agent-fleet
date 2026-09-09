const EVENT = 'agent-fleet:open-file'

/**
 * Open a file in the app's own viewer.
 *
 * Claude mentions files constantly ("docs/handoff.md — hand that to the coder"), and following one
 * meant reading the path, switching to an editor and finding it there. The mention is the link.
 */
// how many viewers are mounted; with none, the app cannot show the file itself
let viewers = 0

export function openFile(path: string): void {
  if (!viewers) {
    void window.api.shell.openPath(path)
    return
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { path } }))
}

export function onOpenFile(cb: (path: string) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<{ path: string }>).detail
    if (d?.path) cb(d.path)
  }
  viewers++
  window.addEventListener(EVENT, h)
  return () => {
    viewers--
    window.removeEventListener(EVENT, h)
  }
}

/**
 * Paths worth turning into links, as they actually appear in an answer: `src/main/index.ts`,
 * `./scripts/build.sh`, `~/.claude/settings.json`, `/Users/x/repo/file.ts`. Deliberately narrow —
 * it must not swallow prose, so a path needs a separator and an extension, and a URL is left alone.
 */
const PATH = /(?<![\w:/])((?:~|\.{1,2})?\/?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g

export interface Piece {
  text: string
  path: boolean
}

/** The whitespace-delimited word a match sits inside, which is what says whether it is a URL. */
function wordAt(text: string, i: number): string {
  let start = i
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  let end = i
  while (end < text.length && !/\s/.test(text[end])) end++
  return text.slice(start, end)
}

export function splitPaths(text: string): Piece[] {
  const out: Piece[] = []
  let at = 0
  for (const m of text.matchAll(PATH)) {
    const i = m.index ?? 0
    // The path part of a URL matches this pattern too, and the match starts after the scheme and
    // domain, so looking at a few characters behind it is not enough: judge the whole word.
    if (wordAt(text, i).includes('://')) continue
    if (i > at) out.push({ text: text.slice(at, i), path: false })
    out.push({ text: m[1], path: true })
    at = i + m[1].length
  }
  if (at < text.length) out.push({ text: text.slice(at), path: false })
  return out.length ? out : [{ text, path: false }]
}

/** Where a mentioned path actually is: relative ones hang off the session's own directory. */
export function resolvePath(path: string, cwd: string, home = ''): string {
  if (path.startsWith('/')) return path
  if (path.startsWith('~')) return home ? home + path.slice(1) : path
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}
