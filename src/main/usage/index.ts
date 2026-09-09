import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageContext, UsageLimit, UsageSnapshot } from '../../shared/types'

const CLAUDE_JSON = join(homedir(), '.claude.json')
const STATS_CACHE = join(homedir(), '.claude', 'stats-cache.json')
// where the patched status line drops each session's payload; see resources/hooks/agent-fleet-status.sh
const STATUS_DIR = join(homedir(), '.claude', 'agent-fleet', 'status')
// a payload older than this belongs to a session that stopped rendering, so it says nothing about now
const FRESH_MS = 30 * 60 * 1000
// the same flag file the status line reads for its [o_o] badge
const CAVEMAN_FLAG = join(homedir(), '.claude', '.caveman-active')

interface RawLimit {
  kind?: string
  group?: string
  percent?: number | null
  severity?: string
  resets_at?: string | null
  is_active?: boolean
  scope?: { model?: { display_name?: string | null } | null } | null
}

function read<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

function labelFor(l: RawLimit): string {
  const model = l.scope?.model?.display_name
  if (model) return model
  if (l.kind === 'session') return '5 hour'
  if (l.kind === 'weekly_all') return '7 day'
  return l.kind ?? 'limit'
}

interface StatusPayload {
  session_id?: string
  context_window?: { used_percentage?: number; total_input_tokens?: number; context_window_size?: number }
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number }>
}

/**
 * The live half of the picture.
 *
 * Claude Code hands its status line fresh rate limits and context on stdin, several times a second,
 * and nothing writes them to disk on its own — the cache in ~/.claude.json is refreshed rarely and is
 * routinely hours old. The patched status line drops each payload in STATUS_DIR; this reads the
 * newest one for the account-wide limits and keeps every recent one for its session's context.
 */
function fromStatusLine(): { at: number; limits: UsageLimit[]; contexts: Record<string, UsageContext> } | null {
  let files: string[]
  try {
    files = readdirSync(STATUS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return null
  }
  const now = Date.now()
  const contexts: Record<string, UsageContext> = {}
  let newest: { at: number; payload: StatusPayload } | null = null
  for (const f of files) {
    let at: number
    try {
      at = statSync(join(STATUS_DIR, f)).mtimeMs
    } catch {
      continue
    }
    if (now - at > FRESH_MS) continue
    const payload = read<StatusPayload>(join(STATUS_DIR, f))
    if (!payload) continue
    const id = payload.session_id ?? f.replace(/\.json$/, '')
    const cw = payload.context_window
    if (cw && typeof cw.used_percentage === 'number') {
      contexts[id] = {
        percent: Math.max(0, Math.min(100, Math.round(cw.used_percentage))),
        tokens: cw.total_input_tokens ?? 0,
        size: cw.context_window_size ?? 0,
        at
      }
    }
    if (!newest || at > newest.at) newest = { at, payload }
  }
  if (!newest) return null

  // five_hour -> "5 hour", seven_day -> "7 day"; anything else keeps its own name
  const NAMES: Record<string, string> = { five_hour: '5 hour', seven_day: '7 day' }
  const limits: UsageLimit[] = Object.entries(newest.payload.rate_limits ?? {})
    .filter(([, v]) => typeof v?.used_percentage === 'number')
    .map(([kind, v]) => {
      const percent = Math.max(0, Math.min(100, Math.round(v.used_percentage!)))
      return {
        key: kind,
        label: NAMES[kind] ?? kind.replace(/_/g, ' '),
        kind: kind === 'five_hour' ? 'session' : kind === 'seven_day' ? 'weekly_all' : kind,
        percent,
        severity: percent >= 95 ? 'critical' : percent >= 80 ? 'warning' : 'normal',
        // the payload counts in seconds; the rest of the app speaks ISO
        resetsAt: v.resets_at ? new Date(v.resets_at * 1000).toISOString() : null,
        active: true
      }
    })
  return { at: newest.at, limits, contexts }
}

/**
 * Claude Code caches the account's rate-limit utilization in ~/.claude.json, but refreshes it only
 * now and then, so the live status-line payload wins wherever it has an answer. The cache is still
 * the only source for the per-model weekly limits, which never appear in that payload.
 */
export function usage(): UsageSnapshot {
  const cfg = read<{
    cachedUsageUtilization?: { fetchedAtMs?: number; utilization?: { limits?: RawLimit[] } }
  }>(CLAUDE_JSON)
  const cached = cfg?.cachedUsageUtilization
  const cachedLimits: UsageLimit[] = (cached?.utilization?.limits ?? [])
    .filter((l) => typeof l.percent === 'number')
    .map((l) => ({
      key: `${l.kind}-${l.scope?.model?.display_name ?? ''}`,
      label: labelFor(l),
      kind: l.kind ?? 'limit',
      percent: Math.max(0, Math.min(100, Math.round(l.percent!))),
      severity: l.severity ?? 'normal',
      resetsAt: l.resets_at ?? null,
      active: !!l.is_active
    }))

  const raw = read<{
    totalSessions?: number
    totalMessages?: number
    firstSessionDate?: string
    dailyActivity?: Array<{ date: string; messageCount: number; sessionCount: number; toolCallCount: number }>
    modelUsage?: Record<
      string,
      { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
    >
  }>(STATS_CACHE)

  const stats = raw
    ? {
        totalSessions: raw.totalSessions ?? 0,
        totalMessages: raw.totalMessages ?? 0,
        totalToolCalls: (raw.dailyActivity ?? []).reduce((n, d) => n + (d.toolCallCount ?? 0), 0),
        firstSessionDate: raw.firstSessionDate ?? null,
        daily: (raw.dailyActivity ?? []).slice(-45).map((d) => ({
          date: d.date,
          messages: d.messageCount ?? 0,
          sessions: d.sessionCount ?? 0,
          toolCalls: d.toolCallCount ?? 0
        })),
        models: Object.entries(raw.modelUsage ?? {})
          .map(([model, m]) => ({
            model: model.replace(/^claude-/, ''),
            input: m.inputTokens ?? 0,
            output: m.outputTokens ?? 0,
            cacheRead: m.cacheReadInputTokens ?? 0,
            cacheWrite: m.cacheCreationInputTokens ?? 0
          }))
          .filter((m) => m.input + m.output + m.cacheRead + m.cacheWrite > 0)
      }
    : null

  // the flag file holds the intensity ("full", "lite", "ultra"); its absence means off
  const caveman = existsSync(CAVEMAN_FLAG) ? (readText(CAVEMAN_FLAG) ?? 'on') : null

  // live first, then whatever the cache knows that the payload never carries (the per-model weeklies)
  const live = fromStatusLine()
  const limits = live
    ? [...live.limits, ...cachedLimits.filter((l) => !live.limits.some((x) => x.kind === l.kind))]
    : cachedLimits

  return {
    fetchedAt: live?.at ?? cached?.fetchedAtMs ?? null,
    live: !!live,
    limits,
    contexts: live?.contexts ?? {},
    stats,
    caveman
  }
}
