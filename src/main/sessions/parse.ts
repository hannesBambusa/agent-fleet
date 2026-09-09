import type { Session, TranscriptItem } from '../../shared/types'

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
      push(s, { id: `${id}-${String(b.id ?? '')}`, ts, kind: 'tool', tool: name, text: summary.slice(0, 500), toolUseId })
    }
  }
  return true
}
