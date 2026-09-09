export interface DiffRow {
  kind: 'context' | 'add' | 'del'
  text: string
  /** the line this is in the file, when the edit could be located */
  n?: number
  /** the line split into runs, so the words that actually changed can be picked out */
  parts?: Array<{ text: string; changed: boolean }>
}

/**
 * A line diff, small enough to run on every expanded tool call.
 *
 * Classic LCS over lines, which is what a person reading a code change expects: unchanged lines stay
 * put and act as anchors, so a one-word change does not read as a whole block being replaced. The
 * inputs are already capped where they are captured, so the quadratic table is bounded.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  if (!a.length) return b.map((text) => ({ kind: 'add' as const, text }))
  if (!b.length) return a.map((text) => ({ kind: 'del' as const, text }))

  // lengths[i][j] = longest common run between a.slice(i) and b.slice(j)
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i] })
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i++] })
    } else {
      rows.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) rows.push({ kind: 'del', text: a[i++] })
  while (j < b.length) rows.push({ kind: 'add', text: b[j++] })
  return rows
}

/**
 * Which words changed between a removed line and the added line that replaced it.
 *
 * A changed line is usually a changed word, and highlighting the whole line hides that. Token-level
 * LCS over words and separators, the same shape as the line diff a level up.
 */
function tokens(line: string): string[] {
  return line.split(/(\s+|[^\w\s])/).filter((t) => t !== '')
}

function markPair(del: DiffRow, add: DiffRow): void {
  const a = tokens(del.text)
  const b = tokens(add.text)
  // a rewrite shares nothing worth pointing at, and marking every token is just a slower full line
  if (!a.length || !b.length || a.length + b.length > 400) return
  const L: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const delParts: DiffRow['parts'] = []
  const addParts: DiffRow['parts'] = []
  const put = (into: DiffRow['parts'], text: string, changed: boolean): void => {
    const last = into![into!.length - 1]
    if (last && last.changed === changed) last.text += text
    else into!.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      put(delParts, a[i], false)
      put(addParts, b[j], false)
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      put(delParts, a[i++], true)
    } else {
      put(addParts, b[j++], true)
    }
  }
  while (i < a.length) put(delParts, a[i++], true)
  while (j < b.length) put(addParts, b[j++], true)
  // nothing in common means the highlight would cover the line; leave it plain
  if (delParts.some((p) => !p.changed) || addParts.some((p) => !p.changed)) {
    del.parts = delParts
    add.parts = addParts
  }
}

/**
 * Numbers the rows and marks the changed words.
 *
 * `start` is the line the removed text begins at. Added lines carry the number they will have once
 * the edit lands, which is what the editor will show when you go and look.
 */
export function annotate(rows: DiffRow[], start?: number): DiffRow[] {
  if (start) {
    // two counters, because a removed line is numbered in the old file and an added one in the new
    let oldN = start
    let newN = start
    for (const r of rows) {
      if (r.kind === 'del') r.n = oldN++
      else if (r.kind === 'add') r.n = newN++
      else {
        r.n = newN
        oldN++
        newN++
      }
    }
  }
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].kind === 'del' && rows[i + 1].kind === 'add') markPair(rows[i], rows[i + 1])
  }
  return rows
}

/** How the change reads in one line, the way Claude Code words it. */
export function summarise(rows: DiffRow[]): string {
  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length
  const part = (n: number, verb: string): string => `${verb} ${n} line${n === 1 ? '' : 's'}`
  if (added && removed) return `${part(added, 'Added')}, removed ${removed}`
  if (added) return part(added, 'Added')
  if (removed) return part(removed, 'Removed')
  return 'no change'
}

/**
 * Unchanged lines far from any change are noise. Keeps `pad` lines either side of every edit and
 * replaces the rest with a marker, the way a unified diff does.
 */
export function collapse(rows: DiffRow[], pad = 2): DiffRow[] {
  const keep = new Set<number>()
  rows.forEach((r, i) => {
    if (r.kind === 'context') return
    for (let k = Math.max(0, i - pad); k <= Math.min(rows.length - 1, i + pad); k++) keep.add(k)
  })
  if (!keep.size) return rows.slice(0, pad * 2)
  const out: DiffRow[] = []
  let skipped = 0
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      if (skipped) {
        out.push({ kind: 'context', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
        skipped = 0
      }
      out.push(r)
    } else {
      skipped++
    }
  })
  if (skipped) out.push({ kind: 'context', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
  return out
}
