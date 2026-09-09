import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, LaunchRequest, Session } from '../../shared/types'
import { useSessions } from './state/sessions'
import { useHookStatus } from './state/hooks'
import { useAgents } from './state/agents'
import { useNow } from './lib/useNow'
import { TopBar } from './fleet/TopBar'
import { FleetView } from './fleet/FleetView'
import { Rail } from './fleet/Rail'
import { DetailPanel } from './fleet/DetailPanel'
import { Workspace } from './workspace/Workspace'
import { LaunchDialog } from './launch/LaunchDialog'
import { termSize } from './terminal/Terminal'
import { useUiScale } from './state/uiScale'
import { useUsage } from './state/usage'
import { useTheme } from './state/theme'
import { usePtyActivity } from './state/ptyActivity'
import { Divider } from './lib/Divider'

const FLEET_DEFAULT = 900
const FLEET_MIN = 200
const COMPACT_BELOW = 520
const RIGHT_MIN = 560
const WIDTH_KEY = 'agent-fleet.fleetWidth'

// the tailer's own gap between two tool calls; a placeholder is judged by the same clock as a session
const BETWEEN_TOOLS_MS = 25_000

// a launched agent whose JSONL has not appeared yet still needs a card
function placeholder(a: Agent, ptyAt: number | undefined): Session {
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
    topic: a.name,
    model: null,
    version: null,
    lastCommand: null,
    lastCommandAt: null,
    lastPrompt: a.prompt || null,
    lastPromptAt: a.createdAt,
    lastEventAt: a.createdAt,
    firstEventAt: a.createdAt,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    context: 0,
    currentTool: null,
    // No transcript yet, so the pty is the only proof of work: Claude Code can go minutes without
    // writing the JSONL while it is genuinely busy, and time since launch alone called those agents
    // idle. The launch window stays as the case where nothing has been printed yet.
    state:
      a.status !== 'exited' &&
      ((ptyAt !== undefined && Date.now() - ptyAt < BETWEEN_TOOLS_MS) ||
        Date.now() - Date.parse(a.createdAt) < 60_000)
        ? 'running'
        : 'idle',
    closed: false,
    hookState: null,
    transcript: []
  }
}

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    if (v >= FLEET_MIN) return v
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
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [fleetWidth, setFleetWidth] = useState(readWidth)
  const dragFrom = useRef(0)

  const agentBySession = useMemo(() => new Map(agents.map((a) => [a.sessionId, a])), [agents])
  // everything the tailer knows, including finished subagents and closed sessions
  const known = useMemo(() => {
    return all.map((s) => {
      if (s.parentId) return s
      const a = agentBySession.get(s.id)
      return { ...s, origin: a ? 'app' : 'terminal', topic: s.topic ?? a?.name ?? null } as Session
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
      .map((a) => placeholder(a, ptyAt.get(a.id)))
    return [...extra, ...live].map((s) => {
      if (s.parentId) return s
      const a = agentBySession.get(s.id)
      return { ...s, origin: a ? 'app' : 'terminal', topic: s.topic ?? a?.name ?? null } as Session
    })
    // `now` is in here because a placeholder's state is read off the clock: without it a card that
    // stopped printing would keep claiming running until some unrelated session happened to update
  }, [all, agents, agentBySession, ptyAt, now])

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
    const max = Math.max(FLEET_MIN, window.innerWidth / zoom - RIGHT_MIN)
    setFleetWidth(Math.min(max, Math.max(FLEET_MIN, dragFrom.current + delta)))
  }
  const persistFleet = (): void => {
    try {
      localStorage.setItem(WIDTH_KEY, String(fleetWidth))
    } catch {
      // storage unavailable
    }
  }

  // a launched agent with no transcript yet exists only as a placeholder in `sessions`
  const current = sessions.find((s) => s.id === opened) ?? known.find((s) => s.id === opened) ?? null
  const hovered = sessions.find((s) => s.id === selected) ?? known.find((s) => s.id === selected) ?? null
  const agent = current ? (agentBySession.get(current.id) ?? null) : null
  const compact = fleetWidth < COMPACT_BELOW

  async function launch(req: LaunchRequest): Promise<void> {
    setLaunching(false)
    const { cols, rows } = termSize()
    const a = await window.api.launchAgent(req, cols, rows)
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
        <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: fleetWidth }}>
          {compact ? (
            <Rail sessions={sessions} opened={opened} now={now} onOpen={open} onFleet={() => setFleetWidth(FLEET_DEFAULT)} />
          ) : (
            <FleetView
              sessions={sessions}
              history={known}
              usage={usage}
              selected={opened ?? selected}
              now={now}
              onSelect={setSelected}
              onOpen={open}
            />
          )}
        </div>
        <Divider
          onStart={() => (dragFrom.current = fleetWidth)}
          onDrag={dragFleet}
          onEnd={persistFleet}
          onDoubleClick={() => setFleetWidth(compact ? FLEET_DEFAULT : FLEET_MIN + 40)}
          title="drag to resize · double-click to toggle compact"
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
    </div>
  )
}
