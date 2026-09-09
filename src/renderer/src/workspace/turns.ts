import type { TranscriptEdit, TranscriptItem } from '../../../shared/types'

/**
 * The transcript as a conversation.
 *
 * A JSONL transcript is a flat stream of prompts, assistant text, tool calls and their results; a
 * chat is turns. Grouping them is pure, so it lives away from the view that draws it.
 */
export interface Turn {
  id: string
  role: 'you' | 'claude'
  ts: string
  text: string
  command?: boolean
  tools: Array<{ id: string; tool: string; text: string; result?: TranscriptItem; edit?: TranscriptEdit }>
}

// one word per turn, picked from the turn's own start time so it holds still while the turn runs
const VERBS = [
  'Baking', 'Germinating', 'Percolating', 'Simmering', 'Noodling', 'Cogitating', 'Whirring', 'Pondering',
  'Brewing', 'Tinkering', 'Rummaging', 'Puttering', 'Chewing', 'Untangling', 'Kneading', 'Distilling',
  'Marinating', 'Spelunking', 'Shuffling', 'Conjuring', 'Sifting', 'Plotting', 'Wrangling', 'Composing',
  'Ruminating', 'Assembling', 'Polishing', 'Foraging', 'Weaving', 'Calibrating'
]

export function verbFor(seed: number): string {
  return VERBS[Math.abs(Math.floor(seed / 1000)) % VERBS.length]
}

/** the transcript is a flat log; a chat needs it grouped into turns with tools folded in */
export function toTurns(items: TranscriptItem[]): Turn[] {
  const out: Turn[] = []
  // every tool call so far, by its tool_use id. Results for a batch of calls all arrive in one user
  // message and can answer a call from an earlier turn, so the lookup has to outlive `cur`.
  const byToolUseId = new Map<string, Turn['tools'][number]>()
  let cur: Turn | null = null
  for (const it of items) {
    if (it.kind === 'prompt' || it.kind === 'command') {
      cur = null
      out.push({ id: it.id, role: 'you', ts: it.ts, text: it.text, command: it.kind === 'command', tools: [] })
      continue
    }
    if (it.kind === 'text') {
      cur = { id: it.id, role: 'claude', ts: it.ts, text: it.text, tools: [] }
      out.push(cur)
      continue
    }
    if (it.kind === 'tool') {
      if (!cur || cur.role !== 'claude') {
        cur = { id: it.id, role: 'claude', ts: it.ts, text: '', tools: [] }
        out.push(cur)
      }
      const call = { id: it.id, tool: it.tool ?? 'tool', text: it.text, edit: it.edit }
      cur.tools.push(call)
      if (it.toolUseId) byToolUseId.set(it.toolUseId, call)
      continue
    }
    if (it.kind === 'result') {
      // an item parsed before toolUseId existed carries no id, so it keeps the old last-tool pairing
      const call = it.toolUseId ? byToolUseId.get(it.toolUseId) : cur?.tools[cur.tools.length - 1]
      // a result whose call has already fallen out of the transcript ring has nowhere to go, and
      // hanging it on an unrelated call would show the wrong output under it
      if (call && !call.result) call.result = it
    }
  }
  return out
}
