import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, LaunchRequest, Session, SessionState } from '../../shared/types'
import { useSessions } from './state/sessions'
import { useHookStatus } from './state/hooks'
import { fresh, useHookClaims } from './state/hookState'
import { useAgents } from './state/agents'
import { useNow } from './lib/useNow'
import { TopBar } from './fleet/TopBar'
import { FleetView } from './fleet/FleetView'
import { DetailPanel } from './fleet/DetailPanel'
import { Workspace } from './workspace/Workspace'
import { LaunchDialog } from './launch/LaunchDialog'
import { HandoffDialog } from './launch/HandoffDialog'
import { onHandoff } from './state/handoff'
import { termSize } from './terminal/Terminal'
import { useUiScale } from './state/uiScale'
import { useUsage } from './state/usage'
import { useTheme } from './state/theme'
import { usePtyActivity } from './state/ptyActivity'
import { Divider } from './lib/Divider'

const FLEET_DEFAULT = 900
// the narrowest the tiles need, and the floor for the drag
const DOCK_W = 54
// the width the cycle opens the rail to, wide enough for a row to read
const RAIL_W = 240
const COMPACT_BELOW = 520
// Narrower than a readable row of text. Below it the fleet becomes tiles, which is the only thing
// that still says something at this width.
const MINIMAL_BELOW = 132
const RIGHT_MIN = 560
const WIDTH_KEY = 'agent-fleet.fleetWidth'

// the tailer's own gap between two tool calls; a placeholder is judged by the same clock as a session
const BETWEEN_TOOLS_MS = 25_000

// a launched agent whose JSONL has not appeared yet still needs a card
function placeholder(a: Agent, ptyAt: number | undefined, said: SessionState | null): Session {
  return {
    id: a.sessionId,
    origin: 'app',
    parentId: null,
    parentAgentId: null,
    agentType: null,
    depth: 0,
    file: '',
    cwd: a.cwd ?? a.repoPath,
    repoPath: a.repoPath,
    repo: a.repoName,
    worktree: null,
    branch: null,
    // only a name the user chose says anything; a generated one is just the worktree directory
    topic: a.titled ? a.name : null,
    model: null,
    version: null,
    lastCommand: null,
    lastCommandAt: null,
    commands: [],
    turnEnded: false,
    note: null,
    lastPrompt: a.prompt || null,
    lastPromptAt: a.createdAt,
    lastEventAt: a.createdAt,
    firstEventAt: a.createdAt,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    context: 0,
    currentTool: null,
    // No transcript yet, so state comes from what Claude Code itself has said: a hook claim first,
    // then the pty, which proves it is at least printing. Age since launch is not evidence of work —
    // painting every new agent running for a minute is what made an agent waiting for its first
    // prompt look busy.
    state:
      a.status === 'exited'
        ? 'idle'
        : (said ??
          (ptyAt !== undefined && Date.now() - ptyAt < BETWEEN_TOOLS_MS
            ? 'running'
            : // an agent launched with a prompt starts working at once, and prints nothing for a
              // moment while Claude Code boots; one without a prompt is waiting for you
              a.prompt && Date.now() - Date.parse(a.createdAt) < 15_000
              ? 'running'
              : 'idle')),
    closed: false,
    hookState: null,
    transcript: []
  }
}

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    // the dock width is a legitimate saved width, well below the rail's floor
    if (v >= DOCK_W) return v
  } catch {
    // storage unavailable
  }
  return FLEET_DEFAULT
}

export default function App(): JSX.Element {
  const all = useSessions()
  const agents = useAgents()
  const now = useNow()
  const hooks = useHookStatus()
  const ui = useUiScale()
  const usage = useUsage()
  const theme = useTheme()
  const ptyAt = usePtyActivity()
  const claims = useHookClaims()
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [fleetWidth, setFleetWidth] = useState(readWidth)
  // a width that eases looks right when a button changed it and laggy when a hand is dragging it
  const [dragging, setDragging] = useState(false)
  const dragFrom = useRef(0)

  const agentBySession = useMemo(() => new Map(agents.map((a) => [a.sessionId, a])), [agents])
  // everything the tailer knows, including finished subagents and closed sessions
  const known = useMemo(() => {
    return all.map((s) => {
      if (s.parentId) return s
      const a = agentBySession.get(s.id)
      return { ...s, origin: a ? 'app' : 'terminal', topic: s.topic ?? (a?.titled ? a.name : null) } as Session
    })
  }, [all, agentBySession])

  const sessions = useMemo(() => {
    // a subagent only earns a card while it is actually working; the rest live in the history tab
    const live = all.filter((s) => s.state !== 'ended' && (!s.parentId || s.state === 'running' || s.state === 'waiting'))
    // A placeholder covers the gap before the transcript file appears; main relinks the agent to
    // whatever session Claude actually created, so the placeholder resolves instead of doubling up.
    const tracked = new Set(all.map((s) => s.id))
    const extra = agents
      .filter((a) => !tracked.has(a.sessionId) && a.status !== 'exited')
      .map((a) => placeholder(a, ptyAt.get(a.id), fresh(claims.get(a.sessionId), now)))
    return [...extra, ...live].map((s) => {
      if (s.parentId) return s
      const a = agentBySession.get(s.id)
      return { ...s, origin: a ? 'app' : 'terminal', topic: s.topic ?? (a?.titled ? a.name : null) } as Session
    })
    // `now` is in here because a placeholder's state is read off the clock: without it a card that
    // stopped printing would keep claiming running until some unrelated session happened to update
  }, [all, agents, agentBySession, ptyAt, claims, now])

  // the app announces nothing about the session you are already looking at
  useEffect(() => {
    window.api.attention.watching(opened ?? null)
  }, [opened])

  useEffect(() => window.api.attention.onOpen((id) => open(id)), [open])

  // a file handed to an agent somewhere else
  const [handingOff, setHandingOff] = useState<string | null>(null)
  useEffect(() => onHandoff(setHandingOff), [])

  // a freshly launched agent opens straight into its terminal
  useEffect(() => {
    const fresh = agents.find((a) => a.status === 'starting' && Date.now() - Date.parse(a.createdAt) < 5000)
    if (fresh) {
      setSelected(fresh.sessionId)
      setOpened(fresh.sessionId)
    }
  }, [agents])
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        setLaunching(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '1') {
        e.preventDefault()
        setOpened(null)
      }
      if (e.key === 'Escape' && opened && !launching) setOpened(null)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [opened, launching])

  const dragFleet = (delta: number): void => {
    const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1
    const max = Math.max(DOCK_W, window.innerWidth / zoom - RIGHT_MIN)
    // No snap and no dead zone: the handle follows the hand all the way down, and the fleet changes
    // shape as it passes each threshold. A jump makes the switch feel like a mode change rather
    // than the panel simply running out of room.
    setFleetWidth(Math.min(max, Math.max(DOCK_W, dragFrom.current + delta)))
  }
  // Every route to a new width is remembered, not only dragging: the divider's double-click toggles
  // compact, and the rail's own back button expands it, and both were forgotten on restart.
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(fleetWidth))
    } catch {
      // storage unavailable
    }
  }, [fleetWidth])

  // a launched agent with no transcript yet exists only as a placeholder in `sessions`
  const current = sessions.find((s) => s.id === opened) ?? known.find((s) => s.id === opened) ?? null
  const hovered = sessions.find((s) => s.id === selected) ?? known.find((s) => s.id === selected) ?? null
  const agent = current ? (agentBySession.get(current.id) ?? null) : null
  const minimal = fleetWidth < MINIMAL_BELOW
  const compact = fleetWidth < COMPACT_BELOW

  async function launch(req: LaunchRequest): Promise<void> {
    setLaunching(false)
    const { cols, rows } = termSize()
    const a = await window.api.agents.launchAgent(req, cols, rows)
    setSelected(a.sessionId)
    setOpened(a.sessionId)
  }

  function open(id: string): void {
    setSelected(id)
    setOpened(id)
  }

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        sessions={sessions}
        hooksInstalled={hooks.status ? hooks.status.installed : null}
        onInstallHooks={() => void hooks.install()}
        onOpen={open}
        now={now}
        onNew={() => setLaunching(true)}
        crumb={current ? (current.topic ?? current.repo) : null}
        onBack={() => setOpened(null)}
        scale={ui.scale}
        onScale={ui.setScale}
        usage={usage}
        theme={theme.theme}
        onTheme={theme.setTheme}
        contextSession={current ?? hovered ?? sessions.find((s) => s.state === 'running') ?? null}
      />
      <div className="flex min-h-0 flex-1">
        <div
          className={`min-h-0 shrink-0 overflow-hidden ${dragging ? '' : 'width-eased'}`}
          style={{ width: fleetWidth }}
        >
          {/* keyed on the mode, so React remounts and the entry animation plays on every swap */}
          <FleetView
            sessions={sessions}
            history={known}
            usage={usage}
            selected={opened ?? selected}
            now={now}
            onSelect={setSelected}
            onOpen={open}
            compact={compact}
            minimal={minimal}
            opened={opened}
            onExpand={() => setFleetWidth(FLEET_DEFAULT)}
          />
        </div>
        <Divider
          onStart={() => {
            dragFrom.current = fleetWidth
            setDragging(true)
          }}
          onDrag={dragFleet}
          onEnd={() => setDragging(false)}
          onDoubleClick={() =>
            setFleetWidth(minimal ? FLEET_DEFAULT : compact ? DOCK_W : RAIL_W)
          }
          title="drag to resize · double-click to cycle full, compact, tiles"
        />
        <div className="min-w-0 flex-1 bg-[var(--panel)]">
          {current ? (
            <Workspace s={current} agent={agent} now={now} />
          ) : (
            <DetailPanel s={hovered} agent={hovered ? (agentBySession.get(hovered.id) ?? null) : null} now={now} onOpen={open} />
          )}
        </div>
      </div>
      <LaunchDialog open={launching} onClose={() => setLaunching(false)} onLaunch={(r) => void launch(r)} />
      {handingOff && (
        <HandoffDialog
          path={handingOff}
          fromRepo={current?.repo ?? hovered?.repo ?? ''}
          onClose={() => setHandingOff(null)}
          onLaunch={(r) => void launch(r)}
        />
      )}
    </div>
  )
}
