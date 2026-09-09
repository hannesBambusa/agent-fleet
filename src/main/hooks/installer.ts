import { app, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOOK_PORT } from './server'
import type { HookStatus } from '../../shared/types'

const CLAUDE = join(homedir(), '.claude')
const SETTINGS = join(CLAUDE, 'settings.json')
const SCRIPT_DST = join(CLAUDE, 'hooks', 'agent-fleet.sh')
const STATUS_DST = join(CLAUDE, 'hooks', 'agent-fleet-status.sh')
const STATUS_DIR = join(CLAUDE, 'agent-fleet', 'status')
const MARK = 'agent-fleet:status-dump'
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']
const COMMAND = `bash ${SCRIPT_DST}`

interface HookEntry {
  matcher?: string
  hooks: Array<{ type: string; command: string; statusMessage?: string }>
}
interface Settings {
  hooks?: Record<string, HookEntry[]>
  [k: string]: unknown
}

function scriptSrc(name = 'agent-fleet.sh'): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'hooks', name)
    : join(app.getAppPath(), 'resources', 'hooks', name)
}

/**
 * The live rate limits and context percentage exist only in the payload Claude Code pipes to the
 * status line. Nothing writes them to disk, and the cache in ~/.claude.json can be hours old, so the
 * app has to arrange for that payload to be saved.
 *
 * Two cases. A status line already configured gets a marked block appended to it that writes the
 * payload and prints nothing, leaving its own output untouched. No status line at all gets ours,
 * which only saves the payload.
 */
function captureBlock(): string {
  return [
    '',
    `# --- ${MARK} (start) ---`,
    '# Saves the payload agent-fleet reads for its live usage strip. Prints nothing, cannot fail.',
    '{',
    '  af_dir="$HOME/.claude/agent-fleet/status"',
    '  if mkdir -p "$af_dir" 2>/dev/null; then',
    `    af_sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)`,
    '    [ -n "$af_sid" ] || af_sid=unknown',
    `    printf '%s' "$input" > "$af_dir/.$af_sid.tmp" 2>/dev/null && mv -f "$af_dir/.$af_sid.tmp" "$af_dir/$af_sid.json" 2>/dev/null`,
    `    if [ $((RANDOM % 200)) -eq 0 ]; then find "$af_dir" -name '*.json' -mtime +1 -delete 2>/dev/null; fi`,
    '  fi',
    '} 2>/dev/null',
    `# --- ${MARK} (end) ---`,
    ''
  ].join('\n')
}

function statusLinePath(s: Settings): string | null {
  const cmd = (s.statusLine as { command?: string } | undefined)?.command
  if (!cmd) return null
  // "bash /path/to/x.sh" or a bare path, possibly with ~ or $HOME
  const token = cmd.split(/\s+/).find((t) => /\.(sh|bash)$/.test(t)) ?? cmd.split(/\s+/).pop() ?? ''
  const path = token.replace(/^~/, homedir()).replace(/^\$HOME/, homedir())
  return path && existsSync(path) ? path : null
}

export function statusCaptureInstalled(): boolean {
  if (existsSync(STATUS_DIR)) {
    try {
      if (readdirSync(STATUS_DIR).some((f) => f.endsWith('.json'))) return true
    } catch {
      // unreadable; fall through to the script check
    }
  }
  const s = readSettings()
  const own = statusLinePath(s)
  if (own && own === STATUS_DST) return true
  if (own) {
    try {
      return readFileSync(own, 'utf8').includes(MARK)
    } catch {
      return false
    }
  }
  return false
}

/** Patches an existing status line, or installs ours when there is none. Backs up whatever it edits. */
function installStatusCapture(): void {
  mkdirSync(join(CLAUDE, 'hooks'), { recursive: true })
  const s = readSettings()
  const existing = statusLinePath(s)
  if (existing && existing !== STATUS_DST) {
    const body = readFileSync(existing, 'utf8')
    if (body.includes(MARK)) return
    // the block needs $input, so it goes after the line that reads stdin; without one it is appended
    // at the end, where $input may not exist and the block simply does nothing
    const anchor = /^\s*input=\$\(cat\)\s*$/m
    copyFileSync(existing, `${existing}.agent-fleet.bak`)
    writeFileSync(existing, anchor.test(body) ? body.replace(anchor, (m) => m + '\n' + captureBlock()) : body + captureBlock())
    return
  }
  copyFileSync(scriptSrc('agent-fleet-status.sh'), STATUS_DST)
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.agent-fleet.bak`)
  s.statusLine = { type: 'command', command: `bash ${STATUS_DST}` }
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n')
}

function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8')) as Settings
  } catch {
    return {}
  }
}

function has(entries: HookEntry[] | undefined): boolean {
  return !!entries?.some((e) => e.hooks?.some((h) => h.command === COMMAND))
}


export function hookStatus(): HookStatus {
  const s = readSettings()
  const missing = EVENTS.filter((ev) => !has(s.hooks?.[ev]))
  const statusCapture = statusCaptureInstalled()
  return {
    installed: missing.length === 0 && existsSync(SCRIPT_DST) && statusCapture,
    missing,
    port: HOOK_PORT,
    statusCapture
  }
}

/** Asks with a native dialog, then appends our entries. Existing entries are never touched. */
export async function installHooks(): Promise<HookStatus> {
  const status = hookStatus()
  if (status.installed) return status
  if (!status.missing.length && !status.statusCapture) {
    installStatusCapture()
    return hookStatus()
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Install agent-fleet hooks into ~/.claude/settings.json?',
    detail:
      `Adds one entry (matcher "") to each of: ${status.missing.join(', ')}.\n` +
      `Each runs "${COMMAND}", which POSTs the hook JSON to 127.0.0.1:${HOOK_PORT} and never blocks Claude.\n` +
      `Your existing hooks are left as they are. A backup goes to settings.json.agent-fleet.bak.\n\n` +
      `Also saves each status-line payload under ~/.claude/agent-fleet/status, which is the only live ` +
      `source for the rate-limit and context meters. Your status line keeps printing exactly what it ` +
      `prints now.`
  })
  if (response !== 0) return status

  mkdirSync(join(CLAUDE, 'hooks'), { recursive: true })
  copyFileSync(scriptSrc(), SCRIPT_DST)
  const s = readSettings()
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.agent-fleet.bak`)
  s.hooks ??= {}
  for (const ev of status.missing) {
    s.hooks[ev] ??= []
    s.hooks[ev].push({ matcher: '', hooks: [{ type: 'command', command: COMMAND }] })
  }
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n')
  installStatusCapture()
  return hookStatus()
}

/** Removes only entries whose command is ours, and undoes the status-line capture the same way. */
export function uninstallHooks(): HookStatus {
  const s = readSettings()
  const sl = statusLinePath(s)
  if (sl === STATUS_DST) {
    delete s.statusLine
  } else if (sl) {
    try {
      const body = readFileSync(sl, 'utf8')
      if (body.includes(MARK)) {
        // the banner may be padded with trailing dashes, so match a run of them
        const block = new RegExp(`\n?# --- ${MARK} \\(start\\) -+[\\s\\S]*?# --- ${MARK} \\(end\\) -+\n`)
        writeFileSync(sl, body.replace(block, '\n'))
      }
    } catch {
      // leave the script alone if it cannot be read
    }
  }
  if (s.hooks) {
    for (const ev of Object.keys(s.hooks)) {
      s.hooks[ev] = s.hooks[ev]
        .map((e) => ({ ...e, hooks: e.hooks.filter((h) => h.command !== COMMAND) }))
        .filter((e) => e.hooks.length > 0)
      if (!s.hooks[ev].length) delete s.hooks[ev]
    }
    writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n')
  }
  return hookStatus()
}
