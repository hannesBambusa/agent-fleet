import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { DirEntry, FileContents } from '../../shared/types'

const CLAUDE = join(homedir(), '.claude')
// enough to read; a file past this is being looked at for the wrong reason
const MAX_BYTES = 1024 * 1024

/**
 * Reading files for the viewer.
 *
 * The renderer cannot touch the filesystem, and it should not be able to ask for any path either: a
 * page it renders is full of strings an agent wrote. Every read is therefore checked against a set
 * of roots the app already works in — the repositories it knows about, and Claude Code's own config,
 * which is where a skill or command lives.
 */
export function allow(roots: string[], path: string): string | null {
  const full = resolve(path)
  const ok = [...roots, CLAUDE].some((root) => {
    const r = resolve(root)
    return full === r || full.startsWith(r + sep)
  })
  return ok ? full : null
}

// noise that is never what you opened the browser to look at, and is expensive to walk
const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])

export function listDir(roots: string[], path: string): DirEntry[] {
  const dir = allow(roots, path)
  if (!dir) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: DirEntry[] = []
  for (const name of names) {
    if (SKIP.has(name)) continue
    try {
      const st = statSync(join(dir, name))
      out.push({
        name,
        path: join(dir, name),
        dir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        at: new Date(st.mtimeMs).toISOString()
      })
    } catch {
      // a link to nowhere, or something that vanished mid-listing
    }
  }
  // directories first, then case-insensitive by name, which is how every file browser is read
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** A NUL byte in the first few KB means this is not text, whatever its extension claims. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0)
}

export function readTextFile(roots: string[], path: string): FileContents {
  const file = allow(roots, path)
  const empty: FileContents = { path, text: '', size: 0, truncated: false, binary: false, error: null }
  if (!file) return { ...empty, error: 'outside the folders this app can read' }
  try {
    const size = statSync(file).size
    const buf = readFileSync(file)
    if (looksBinary(buf)) return { ...empty, path: file, size, binary: true }
    const text = buf.subarray(0, MAX_BYTES).toString('utf8')
    return { path: file, text, size, truncated: size > MAX_BYTES, binary: false, error: null }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) }
  }
}
