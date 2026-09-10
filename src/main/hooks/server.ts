import { createServer, type Server } from 'node:http'
import type { HookEvent, SessionState } from '../../shared/types'
import { claimFor } from '../../shared/hooks'
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
  return claimFor(p.hook_event_name ?? '', p.notification_type)
}

export function startHookServer(tailer: Tailer, onEvent?: (e: HookEvent) => void): Server {
  const server = createServer((req, res) => {
    // hook scripts never set these; a web page always does. Nothing else should be posting state.
    if (req.headers.origin || req.headers.referer) {
      res.writeHead(403).end()
      return
    }
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
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[hooks] port ${HOOK_PORT} is taken, so hook events will not arrive. Another agent-fleet is ` +
          `probably running; quit it, or start this one with AGENT_FLEET_HOOK_PORT set to something else.`
      )
      return
    }
    console.error('[hooks] listener failed', err)
  })
  server.listen(HOOK_PORT, '127.0.0.1')
  return server
}
