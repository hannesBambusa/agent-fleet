import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { McpServer } from '../../shared/types'
import { BROWSER_PORT } from '../browser/server'

const CLAUDE_JSON = join(homedir(), '.claude.json')

/**
 * Every MCP server Claude Code could reach from this machine.
 *
 * They are configured in four unrelated places and nothing lists them together: the user's own
 * config, a project's entry in that same file, a `.mcp.json` committed in the repository, and the
 * connectors claude.ai manages. The app adds a fifth of its own, the browser pane it hands to agents
 * launched with one.
 *
 * Nothing on disk records whether a server is connected *now* — that lives inside a running Claude
 * Code process. What can be told truthfully is which sessions have actually called its tools, and
 * that is left to the renderer, which has the transcripts.
 */

interface ServerConfig {
  command?: string
  args?: string[]
  url?: string
  type?: string
  env?: Record<string, string>
}

interface ClaudeJson {
  mcpServers?: Record<string, ServerConfig>
  claudeAiMcpEverConnected?: string[]
  projects?: Record<
    string,
    {
      mcpServers?: Record<string, ServerConfig>
      enabledMcpjsonServers?: string[]
      disabledMcpjsonServers?: string[]
    }
  >
}

function read<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function describe(name: string, c: ServerConfig, scope: McpServer['scope'], origin: string, path: string | null): McpServer {
  const url = c.url ?? null
  return {
    name,
    scope,
    origin,
    // `type` is only set for the remote transports; a command means it is spawned locally
    transport: url ? ((c.type as McpServer['transport']) ?? 'http') : c.command ? 'stdio' : 'managed',
    command: c.command ? [c.command, ...(c.args ?? [])].join(' ') : null,
    url,
    enabled: true,
    path
  }
}

// same reasoning as the catalog: read from several files, asked for by several panes, rarely changes
const TTL_MS = 20 * 1000
let cached: { at: number; key: string; list: McpServer[] } | null = null

export function mcpServers(repoPaths: string[]): McpServer[] {
  const key = repoPaths.join('\u0000')
  if (cached && cached.key === key && Date.now() - cached.at < TTL_MS) return cached.list
  const list = scan(repoPaths)
  cached = { at: Date.now(), key, list }
  return list
}

function scan(repoPaths: string[]): McpServer[] {
  const cfg = read<ClaudeJson>(CLAUDE_JSON) ?? {}
  const out: McpServer[] = []

  for (const [name, c] of Object.entries(cfg.mcpServers ?? {})) {
    out.push(describe(name, c, 'user', 'you', CLAUDE_JSON))
  }

  // the connectors claude.ai runs on your behalf; the config lives on their side, not here
  for (const label of cfg.claudeAiMcpEverConnected ?? []) {
    out.push({
      name: label.replace(/^claude\.ai\s*/, ''),
      scope: 'claude.ai',
      origin: 'claude.ai',
      transport: 'managed',
      command: null,
      url: null,
      enabled: true,
      path: null
    })
  }

  for (const repo of repoPaths) {
    const project = cfg.projects?.[repo]
    const disabled = new Set(project?.disabledMcpjsonServers ?? [])
    for (const [name, c] of Object.entries(project?.mcpServers ?? {})) {
      out.push({ ...describe(name, c, 'project', basename(repo), CLAUDE_JSON), enabled: !disabled.has(name) })
    }
    // a .mcp.json is committed with the repository, so everyone working on it gets the same servers
    const file = join(repo, '.mcp.json')
    const shared = read<{ mcpServers?: Record<string, ServerConfig> }>(file)
    for (const [name, c] of Object.entries(shared?.mcpServers ?? {})) {
      out.push({ ...describe(name, c, 'project', basename(repo), file), enabled: !disabled.has(name) })
    }
  }

  // the app's own: every agent launched with a browser gets this, pointed at its pane
  out.push({
    name: 'browser',
    scope: 'app',
    origin: 'agent-fleet',
    transport: 'stdio',
    command: `node resources/browser-mcp/server.mjs → 127.0.0.1:${BROWSER_PORT}`,
    url: null,
    enabled: true,
    path: null
  })

  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
}
