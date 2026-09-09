import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { BrowserManager } from './manager'
import { runTool, TOOLS } from './tools'

// overridable so a second instance can run alongside the first instead of failing to bind
export const BROWSER_PORT = Number(process.env['AGENT_FLEET_BROWSER_PORT'] ?? 47392)

/**
 * A shared secret, new every run, handed only to the MCP shims this app spawns.
 *
 * The control server drives a real Chromium view: navigate, click, type. Bound to loopback with no
 * check, it was reachable from any page open in the user's normal browser — a cross-origin fetch with
 * a text/plain content type skips preflight, so the request goes through even though the attacker
 * cannot read the reply, and the side effects are the whole point. The secret makes the caller prove
 * it was started by us; the Origin check below refuses anything a web page could send at all.
 */
export const BROWSER_SECRET = randomBytes(24).toString('hex')

// local control plane for the per-agent MCP shims; never exposed beyond 127.0.0.1
export function startBrowserServer(browser: BrowserManager, onActivity?: (agentId: string) => void): Server {
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const json = JSON.stringify(body)
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
      res.end(json)
    }
    // A browser always sets Origin on a cross-origin request and cannot forge this header; our own
    // shim never sets it. Refusing both cases costs nothing and closes the drive-by entirely.
    if (req.headers.origin || req.headers.referer) return send(403, { error: 'forbidden' })
    if (req.headers['x-agent-fleet-secret'] !== BROWSER_SECRET) return send(403, { error: 'forbidden' })
    if (req.method === 'GET' && req.url === '/tools') return send(200, { tools: TOOLS })
    if (req.method !== 'POST' || !req.url?.startsWith('/call/')) return send(404, { error: 'not found' })

    const agentId = decodeURIComponent(req.url.slice('/call/'.length))
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      void (async (): Promise<void> => {
        try {
          const { name, args } = JSON.parse(body || '{}') as { name: string; args?: Record<string, unknown> }
          browser.ensure(agentId)
          onActivity?.(agentId)
          const result = await runTool(browser, agentId, name, args ?? {})
          send(200, result)
        } catch (err) {
          send(200, { error: err instanceof Error ? err.message : String(err) })
        }
      })()
    })
  })
  server.on('error', (err) => console.error('[browser] control server failed', err))
  server.listen(BROWSER_PORT, '127.0.0.1')
  return server
}
