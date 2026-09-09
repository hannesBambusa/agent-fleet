import { createServer, type Server } from 'node:http'
import type { BrowserManager } from './manager'
import { runTool, TOOLS } from './tools'

// overridable so a second instance can run alongside the first instead of failing to bind
export const BROWSER_PORT = Number(process.env['AGENT_FLEET_BROWSER_PORT'] ?? 47392)

// local control plane for the per-agent MCP shims; never exposed beyond 127.0.0.1
export function startBrowserServer(browser: BrowserManager, onActivity?: (agentId: string) => void): Server {
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const json = JSON.stringify(body)
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
      res.end(json)
    }
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
