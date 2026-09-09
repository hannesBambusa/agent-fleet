#!/usr/bin/env node
// MCP stdio server exposing one agent's embedded browser pane in agent-fleet.
// Every tool call is proxied to the app's local control server; the app owns the Chromium view.
// Env: AGENT_FLEET_AGENT (agent id), AGENT_FLEET_BROWSER_PORT (default 47392).

const AGENT = process.env.AGENT_FLEET_AGENT
const PORT = process.env.AGENT_FLEET_BROWSER_PORT || '47392'
const BASE = `http://127.0.0.1:${PORT}`
const PROTOCOL_VERSION = '2024-11-05'

let tools = []

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } })
}

async function loadTools() {
  try {
    const res = await fetch(`${BASE}/tools`)
    const body = await res.json()
    tools = body.tools ?? []
  } catch {
    tools = []
  }
}

async function callTool(name, args) {
  const res = await fetch(`${BASE}/call/${encodeURIComponent(AGENT)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args })
  })
  return res.json()
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      await loadTools()
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-fleet-browser', version: '0.1.0' }
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      if (!tools.length) await loadTools()
      return reply(id, { tools })
    case 'tools/call': {
      const name = params?.name
      try {
        const out = await callTool(name, params?.arguments ?? {})
        if (out.error) return reply(id, { content: [{ type: 'text', text: `Error: ${out.error}` }], isError: true })
        const content = []
        if (out.text) content.push({ type: 'text', text: out.text })
        if (out.image) content.push({ type: 'image', data: out.image.data, mimeType: out.image.mimeType })
        if (!content.length) content.push({ type: 'text', text: 'ok' })
        return reply(id, { content })
      } catch (err) {
        const text = `agent-fleet browser unreachable on ${BASE}: ${err?.message ?? err}. Is the app still running?`
        return reply(id, { content: [{ type: 'text', text }], isError: true })
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }
    Promise.resolve(handle(msg)).catch((err) => fail(msg?.id, -32603, String(err?.message ?? err)))
  }
})
process.stdin.on('end', () => process.exit(0))
