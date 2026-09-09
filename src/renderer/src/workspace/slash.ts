import type { CatalogItem } from '../../../shared/types'

export interface SlashItem {
  /** what gets typed, without the leading slash */
  token: string
  description: string
  hint: string | null
  source: 'built-in' | 'global' | 'plugin' | 'project'
  origin: string
  kind: 'command' | 'skill'
}

// the ones Claude Code ships; they are the most used and appear in no catalog file
const BUILT_IN: Array<[string, string]> = [
  ['clear', 'Start a fresh conversation, forgetting this one'],
  ['compact', 'Summarise the conversation so far and continue with less context'],
  ['context', 'Show what is filling the context window'],
  ['model', 'Switch the model for this session'],
  ['resume', 'Reopen an earlier conversation'],
  ['usage', 'Show plan limits and how much is left'],
  ['cost', 'Show what this session has cost so far'],
  ['agents', 'Manage subagent definitions'],
  ['review', 'Review the current changes'],
  ['init', 'Write a CLAUDE.md for this project'],
  ['help', 'List everything available']
]

export const TONE: Record<SlashItem['source'], string> = {
  'built-in': 'var(--code-fn)',
  global: 'var(--accent)',
  plugin: 'var(--sub)',
  project: 'var(--warn)'
}

/**
 * Everything typable after a slash, from the same files Claude Code reads.
 *
 * A plugin command is namespaced (`caveman:caveman-commit`), a project or user command is its
 * filename, and a skill is invocable by its own name too. Built-ins come from the list above, since
 * they exist in no file to scan.
 */
export function slashItems(catalog: CatalogItem[]): SlashItem[] {
  const out: SlashItem[] = BUILT_IN.map(([token, description]) => ({
    token,
    description,
    hint: null,
    source: 'built-in' as const,
    origin: 'Claude Code',
    kind: 'command' as const
  }))
  for (const i of catalog) {
    if (i.kind === 'agent') continue
    const source = i.source === 'user' ? 'global' : i.source
    const token = i.source === 'plugin' ? `${i.origin}:${i.name}` : i.name
    out.push({
      token,
      description: i.description,
      hint: i.hint,
      source: source as SlashItem['source'],
      origin: i.origin,
      kind: i.kind === 'skill' ? 'skill' : 'command'
    })
  }
  // one entry per token: a skill and a command of the same name are the same thing to type
  const seen = new Map<string, SlashItem>()
  for (const i of out) if (!seen.has(i.token)) seen.set(i.token, i)
  return [...seen.values()]
}

/** Ranks by where the typed text matches: a prefix beats a word start, which beats anything. */
function score(item: SlashItem, q: string): number {
  if (!q) return item.source === 'built-in' ? 1 : 2
  const t = item.token.toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  if (t.split(/[:-]/).some((part) => part.startsWith(q))) return 60
  if (t.includes(q)) return 40
  if (item.description.toLowerCase().includes(q)) return 20
  return 0
}

export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase()
  return items
    .map((i) => ({ i, s: score(i, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i.token.localeCompare(b.i.token))
    .slice(0, 40)
    .map((x) => x.i)
}

/**
 * The typed token when the draft is a slash command being written, or null.
 *
 * A bare `/` opens nothing: the list of everything is not an answer to a question nobody has asked
 * yet, and it covers the composer the moment the key is pressed. One letter is enough to mean
 * something.
 */
export function slashQuery(draft: string): string | null {
  const m = /^\/([\w:.-]+)$/.exec(draft)
  return m ? m[1] : null
}
