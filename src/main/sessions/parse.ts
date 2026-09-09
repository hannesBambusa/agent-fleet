import type { Session, TranscriptItem } from '../../shared/types'

const MAX_TRANSCRIPT = 400
const COMMAND_RE = new RegExp('<command-name>([^<]+)</command-name>')
// stdout and stderr are written the same way, and a command that failed is exactly the one whose
// output has to reach the chat
const OUTPUT_RE = new RegExp('<local-command-(stdout|stderr)>([\\s\\S]*)</local-command-\\1>')

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
  // system lines carry their text here, as a plain string rather than the block array a message uses
  content?: unknown
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
  if (d.type === 'system' && d.subtype === 'local_command') return applyCommand(s, textOf(d.content), id, ts)
  return d.type === 'system' && d.subtype === 'turn_duration'
}

/**
 * A slash command, or what one printed.
 *
 * Claude Code writes both of those as one of two shapes: a `user` line for some commands, a `system`
 * line with subtype `local_command` for others, both carrying the same tags. Both paths come through
 * here so the chat sees one kind of item whichever shape happened to be written.
 */
function applyCommand(s: Session, text: string, id: string, ts: string): boolean {
  const cmd = COMMAND_RE.exec(text)
  if (cmd) {
    const name = cmd[1].trim()
    s.lastCommand = name
    s.lastCommandAt = ts
    if (repeated(s, name, ts)) return false
    s.turns += 1
    push(s, { id, ts, kind: 'command', text: name })
    return true
  }
  const out = OUTPUT_RE.exec(text)
  if (!out) return false
  push(s, { id, ts, kind: 'system', text: out[2].slice(0, 2000), isError: out[1] === 'stderr' })
  return true
}

/**
 * Whether this is a second record of the command already in the transcript.
 *
 * An interactive command is written down again as it moves on, `/mcp` once for the reconnect it did
 * and once for dismissing its picker, and the two records need not share a shape. Only the command's
 * own output sits between them, so anything else in the way means it really was run twice.
 */
function repeated(s: Session, name: string, ts: string): boolean {
  for (let i = s.transcript.length - 1; i >= 0; i--) {
    const it = s.transcript[i]
    if (it.kind === 'system') continue
    return it.kind === 'command' && it.text === name && Date.parse(ts) - Date.parse(it.ts) < 30_000
  }
  return false
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
  if (COMMAND_RE.test(text) || OUTPUT_RE.test(text)) return applyCommand(s, text, id, ts)
  // system-injected turns, task notifications among them, are not prompts
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
      push(s, { id: `${id}-${String(b.id ?? '')}`, ts, kind: 'tool', tool: name, text: summary.slice(0, 500), toolUseId })
    }
  }
  return true
}
