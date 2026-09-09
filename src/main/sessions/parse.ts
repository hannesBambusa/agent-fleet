import { readFileSync, statSync } from 'node:fs'
import type { Session, TranscriptEdit, TranscriptItem } from '../../shared/types'

const MAX_TRANSCRIPT = 400
const COMMAND_RE = new RegExp('<command-name>([^<]+)</command-name>')

interface Line {
  type?: string
  subtype?: string
  uuid?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: {
    role?: string
    model?: string
    stop_reason?: string | null
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

type Block = Record<string, unknown>

function push(s: Session, item: TranscriptItem): void {
  s.transcript.push(item)
  if (s.transcript.length > MAX_TRANSCRIPT) s.transcript.splice(0, s.transcript.length - MAX_TRANSCRIPT)
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as Block[]) : []
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return blocks(content)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
}

function toolSummary(input: Block): string {
  for (const key of ['command', 'file_path', 'description', 'pattern', 'url', 'prompt']) {
    const v = input[key]
    if (typeof v === 'string' && v) return v
  }
  return JSON.stringify(input).slice(0, 200)
}

// how much of an edit is worth keeping in a ring of 400 items: enough to read, not a whole file
const EDIT_CAP = 2400
// files are only opened for an edit this fresh: replaying history would read hundreds of them, and
// the numbers would be wrong anyway once the file has moved on
const LOCATE_MS = 10 * 60 * 1000
const LOCATE_MAX_BYTES = 512 * 1024

// One MultiEdit, or a run of edits to the same file, would otherwise read it from disk once per
// call, synchronously, on the thread that answers every IPC message. Keyed by mtime, so an edit
// that lands changes the key and the next lookup reads the new content.
const bodies = new Map<string, { mtime: number; text: string }>()

function bodyOf(path: string): string | null {
  let st: { size: number; mtimeMs: number }
  try {
    st = statSync(path)
  } catch {
    return null
  }
  if (st.size > LOCATE_MAX_BYTES) return null
  const seen = bodies.get(path)
  if (seen && seen.mtime === st.mtimeMs) return seen.text
  try {
    const text = readFileSync(path, 'utf8')
    // a handful of files are in flight at a time; this is a burst cache, not a store
    if (bodies.size > 24) bodies.clear()
    bodies.set(path, { mtime: st.mtimeMs, text })
    return text
  } catch {
    return null
  }
}

/**
 * Which line an edit lands on.
 *
 * The tool call carries the text being replaced but not where it sits, and Claude Code's own reply
 * no longer includes the numbered snippet, so the only way to number the diff is to find the text in
 * the file. Ambiguous or missing means no numbers rather than wrong ones.
 */
function lineOf(path: string, needle: string, ts: string): number | undefined {
  if (!path || !needle) return undefined
  if (Date.now() - Date.parse(ts) > LOCATE_MS) return undefined
  const body = bodyOf(path)
  if (!body) return undefined
  const at = body.indexOf(needle)
  if (at < 0 || body.indexOf(needle, at + 1) >= 0) return undefined
  return body.slice(0, at).split('\n').length
}

/**
 * What a file-editing call is about to do.
 *
 * Claude Code shows the change inline as it makes it, and the summary line alone ("src/x.ts") says
 * nothing about what happened. The strings are already in the tool input; this keeps a bounded slice
 * of them so the chat can draw the same diff.
 */
function editOf(tool: string, input: Block, ts: string): TranscriptEdit | undefined {
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (tool === 'Edit' || tool === 'NotebookEdit') {
    const before = str('old_string') || str('old_source')
    const after = str('new_string') || str('new_source')
    if (!before && !after) return undefined
    return {
      path,
      before: before.slice(0, EDIT_CAP),
      after: after.slice(0, EDIT_CAP),
      line: lineOf(path, before, ts)
    }
  }
  if (tool === 'Write') {
    const after = str('content')
    if (!after) return undefined
    // a write replaces the file, so its diff starts at the top
    return { path, before: '', after: after.slice(0, EDIT_CAP), line: 1 }
  }
  if (tool === 'MultiEdit') {
    const list = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : []
    const first = list[0]
    if (!first) return undefined
    const before = typeof first.old_string === 'string' ? first.old_string : ''
    const after = typeof first.new_string === 'string' ? first.new_string : ''
    return {
      path,
      before: before.slice(0, EDIT_CAP),
      after: after.slice(0, EDIT_CAP),
      more: list.length - 1,
      line: lineOf(path, before, ts)
    }
  }
  return undefined
}

/** Apply one JSONL line to the session. Returns true when something user-visible changed. */
export function applyLine(s: Session, raw: string): boolean {
  let d: Line
  try {
    d = JSON.parse(raw) as Line
  } catch {
    return false
  }
  // sidechain lines belong to subagent files; in the root file they are ignored
  if (!d.type || (d.isSidechain && !s.parentId)) return false
  const ts = d.timestamp ?? s.lastEventAt ?? new Date().toISOString()
  if (d.cwd) s.cwd = d.cwd
  if (d.gitBranch) s.branch = d.gitBranch
  if (d.version) s.version = d.version
  if (d.timestamp) {
    s.lastEventAt = ts
    if (!s.firstEventAt) s.firstEventAt = ts
  }
  const id = d.uuid ?? `${ts}-${s.transcript.length}`

  if (d.type === 'user') return applyUser(s, d, id, ts)
  if (d.type === 'assistant') return applyAssistant(s, d, id, ts)
  return d.type === 'system' && d.subtype === 'turn_duration'
}

function applyUser(s: Session, d: Line, id: string, ts: string): boolean {
  const content = d.message?.content
  const results = blocks(content).filter((b) => b.type === 'tool_result')
  if (results.length) {
    s.currentTool = null
    for (const r of results) {
      const text = typeof r.content === 'string' ? r.content : textOf(r.content)
      const toolUseId = typeof r.tool_use_id === 'string' ? r.tool_use_id : undefined
      push(s, { id, ts, kind: 'result', text: text.slice(0, 2000), isError: !!r.is_error, toolUseId })
    }
    return true
  }
  if (d.isMeta) return false
  const text = textOf(content)
  const cmd = COMMAND_RE.exec(text)
  if (cmd) {
    s.lastCommand = cmd[1].trim()
    s.lastCommandAt = ts
    // Commands are the spine of how a session was worked: /git-add, /preflight, /commit. They are
    // rare enough to keep all of them, unlike the transcript, which is a ring and forgets.
    s.commands.push({ name: s.lastCommand, at: ts })
    if (s.commands.length > 300) s.commands.shift()
    s.turns += 1
    push(s, { id, ts, kind: 'command', text: s.lastCommand })
    return true
  }
  // system-injected turns (task notifications, local command output) are not prompts
  if (!text || text.trimStart().startsWith('<')) return false
  s.lastPrompt = text.slice(0, 500)
  s.lastPromptAt = ts
  s.turns += 1
  push(s, { id, ts, kind: 'prompt', text: text.slice(0, 4000) })
  return true
}

function applyAssistant(s: Session, d: Line, id: string, ts: string): boolean {
  const m = d.message
  if (m?.model) s.model = m.model
  if (m?.usage) {
    s.tokens.input += m.usage.input_tokens ?? 0
    s.tokens.output += m.usage.output_tokens ?? 0
    s.tokens.cacheRead += m.usage.cache_read_input_tokens ?? 0
    s.tokens.cacheWrite += m.usage.cache_creation_input_tokens ?? 0
    s.context = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0)
  }
  for (const b of blocks(m?.content)) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      push(s, { id: `${id}-t`, ts, kind: 'text', text: b.text.slice(0, 4000) })
    } else if (b.type === 'tool_use') {
      const name = String(b.name ?? 'tool')
      s.currentTool = name
      const summary = toolSummary((b.input ?? {}) as Block)
      const toolUseId = typeof b.id === 'string' ? b.id : undefined
      push(s, {
        id: `${id}-${String(b.id ?? '')}`,
        ts,
        kind: 'tool',
        tool: name,
        text: summary.slice(0, 500),
        toolUseId,
        edit: editOf(name, (b.input ?? {}) as Block, ts)
      })
    }
  }
  return true
}
