export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'fn' | 'punct'

export interface Token {
  text: string
  kind: TokenKind
}

/**
 * Enough syntax colouring to read a diff, in about a hundred lines.
 *
 * A code diff in grey is a wall: the eye finds a changed number or a renamed method far faster when
 * strings, numbers and keywords look different from identifiers. A real parser is the wrong trade
 * here — these are three-line fragments, drawn a hundred at a time, and a mis-coloured token costs
 * nothing. So this is a single ordered scan, and anything it does not recognise stays plain.
 */

const KEYWORDS = new Set([
  // the C-like family, which covers js, ts, java, c#, go, rust, swift well enough
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'constructor',
  'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'from', 'func', 'function', 'get', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected',
  'public', 'readonly', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  // python and shell, which show up in these repos as often as anything
  'and', 'def', 'elif', 'except', 'fi', 'not', 'or', 'pass', 'raise', 'then', 'with',
  'None', 'True', 'False'
])

// languages whose line comments start with # rather than //
const HASH_COMMENTS = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'conf', 'env'])

export function langOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

export function highlight(line: string, lang = ''): Token[] {
  const out: Token[] = []
  const hash = HASH_COMMENTS.has(lang)
  let i = 0
  let plain = ''
  const flush = (): void => {
    if (plain) out.push({ text: plain, kind: 'plain' })
    plain = ''
  }
  const push = (text: string, kind: TokenKind): void => {
    flush()
    out.push({ text, kind })
  }

  while (i < line.length) {
    const c = line[i]
    const rest = line.slice(i)

    // a comment runs to the end of the line, so nothing after it needs scanning
    if ((!hash && rest.startsWith('//')) || (hash && c === '#') || rest.startsWith('/*') || rest.startsWith('*')) {
      // a leading `*` is only a comment when it opens the line, as in a doc block
      const isDocStar = rest.startsWith('*') && line.slice(0, i).trim() === ''
      if (!rest.startsWith('*') || isDocStar) {
        push(rest, 'comment')
        return out
      }
    }

    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      push(line.slice(i, Math.min(j + 1, line.length)), 'string')
      i = j + 1
      continue
    }

    if (/[0-9]/.test(c) && !/[\w$]/.test(line[i - 1] ?? '')) {
      const m = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)/.exec(rest)
      if (m) {
        push(m[0], 'number')
        i += m[0].length
        continue
      }
    }

    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^[A-Za-z_$@][\w$]*/.exec(rest)!
      const word = m[0]
      const after = line.slice(i + word.length)
      if (KEYWORDS.has(word)) push(word, 'keyword')
      // a name followed by ( is being called; a name after a dot is a property, coloured the same
      else if (/^\s*\(/.test(after) || line[i - 1] === '.') push(word, 'fn')
      else plain += word
      i += word.length
      continue
    }

    if (/[{}()[\].,;:=<>+\-*/%!&|?]/.test(c)) {
      push(c, 'punct')
      i++
      continue
    }

    plain += c
    i++
  }
  flush()
  return out
}
