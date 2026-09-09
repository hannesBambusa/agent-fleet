import { createServer, type Server } from 'node:http'
import type { HookEvent, SessionState } from '../../shared/types'
import type { Tailer } from '../sessions/tailer'

export const HOOK_PORT = Number(process.env['AGENT_FLEET_HOOK_PORT'] ?? 47391)

interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  notification_type?: string
  message?: string
}

function stateFor(p: HookPayload): SessionState | null {
  switch (p.hook_event_name) {
    // SessionStart is not work. It fires on startup, resume, /clear and compaction, when the session
    // is sitting there waiting for a prompt, and claiming "running" for it painted every freshly
    // opened agent green and put a Working bar over its composer. No claim: let the transcript speak.
    case 'SessionStart':
      return null
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'running'
    case 'Notification':
      return p.notification_type === 'permission_prompt' ? 'waiting' : 'idle'
    case 'Stop':
      return 'idle'
    case 'SessionEnd':
      return 'ended'
    default:
      return null
  }
}

export function startHookServer(tailer: Tailer, onEvent?: (e: HookEvent) => void): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(204).end()
      let p: HookPayload
      try {
        p = JSON.parse(body) as HookPayload
      } catch {
        return
      }
      if (!p.session_id || !p.hook_event_name) return
      const at = new Date().toISOString()
      const state = stateFor(p)
      // PostToolUse means the call is over: keep the tool name out of "currently running"
      const done = p.hook_event_name === 'PostToolUse'
      if (state) tailer.applyHook(p.session_id, state, at, done ? undefined : p.tool_name, done)
      onEvent?.({
        event: p.hook_event_name,
        session_id: p.session_id,
        cwd: p.cwd,
        tool_name: p.tool_name,
        notification_type: p.notification_type,
        at
      })
    })
  })
  server.on('error', (err) => console.error('[hooks] listener failed', err))
  server.listen(HOOK_PORT, '127.0.0.1')
  return server
}
