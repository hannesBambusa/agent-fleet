export type SessionState = 'running' | 'waiting' | 'idle' | 'stale' | 'ended'

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type TranscriptKind = 'prompt' | 'command' | 'text' | 'tool' | 'result' | 'system'

export interface TranscriptItem {
  id: string
  ts: string
  kind: TranscriptKind
  text: string
  tool?: string
  isError?: boolean
  // Anthropic's tool_use id: on a `tool` item the call's own id, on a `result` item the id of the
  // call it answers. Several calls in one assistant message are answered by several results in one
  // user message, so position cannot pair them. Optional because items already in a running
  // session's ring were parsed before this field existed.
  toolUseId?: string
}

export type SessionOrigin = 'app' | 'terminal' | 'subagent'

export interface Session {
  id: string
  // set by the renderer: launched from this app, or picked up from a terminal
  origin?: SessionOrigin
  // subagents: the root session id, the spawning subagent's id (null when spawned by the root), type and nesting depth
  parentId: string | null
  parentAgentId: string | null
  agentType: string | null
  depth: number
  file: string
  cwd: string
  // repo root; for a `claude --worktree` session this is the main checkout, not the worktree dir
  repoPath: string
  repo: string
  // worktree name when cwd is <repo>/.claude/worktrees/<name>
  worktree: string | null
  branch: string | null
  topic: string | null
  model: string | null
  version: string | null
  lastCommand: string | null
  lastCommandAt: string | null
  lastPrompt: string | null
  lastPromptAt: string | null
  lastEventAt: string | null
  firstEventAt: string | null
  turns: number
  tokens: TokenUsage
  // input + cache of the most recent assistant turn = context currently in use
  context: number
  currentTool: string | null
  state: SessionState
  // no `claude` process is running in this session's directory any more
  closed: boolean
  /** last state pushed by a hook, wins over the transcript-derived guess while fresh */
  hookState: { state: SessionState; at: string; tool?: string } | null
  transcript: TranscriptItem[]
}

export interface HookEvent {
  event: string
  session_id: string
  cwd?: string
  tool_name?: string
  notification_type?: string
  at: string
}

export interface HookStatus {
  installed: boolean
  missing: string[]
  port: number
  /** whether the status line is dropping its live payload where the usage strip can read it */
  statusCapture: boolean
}

export interface Repo {
  path: string
  name: string
  // has the Claude Code trust dialog been accepted here (read from ~/.claude.json)
  trusted: boolean
  // git worktrees need at least one commit to branch from
  hasCommits: boolean
  worktree: boolean
  browser: boolean
  setupCommand: string
}

export type AgentStatus = 'starting' | 'live' | 'exited'

export interface Agent {
  id: string
  sessionId: string
  repoPath: string
  repoName: string
  // where the session actually runs (worktree dir once known), used for --resume
  cwd: string | null
  name: string
  prompt: string
  worktree: boolean
  browser: boolean
  // which view this agent opens in: the app's chat, or Claude Code's own terminal
  chat: boolean
  // runs inside tmux, so it survives the app closing and can be reattached later
  detached: boolean
  status: AgentStatus
  exitCode: number | null
  // killed by the app quitting, not by the user; resumed on next start
  interrupted?: boolean
  // ignored files carried into the worktree at launch, so the agent can actually run the project
  seeded?: string[]
  createdAt: string
}

export interface LaunchRequest {
  repoPath: string
  prompt: string
  name: string
  worktree: boolean
  browser: boolean
  chat: boolean
  detached: boolean
  resumeSessionId?: string
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface GitFile {
  path: string
  status: string
  /** raw porcelain letter, e.g. M A D R ? */
  letter: string
  staged: boolean
  /** already committed on this branch, seen by diffing against the base branch */
  committed: boolean
}

export interface GitCommit {
  sha: string
  subject: string
  at: string
  author: string
  /** branch and tag names pointing at this commit */
  refs: string[]
  /** abbreviated parent shas, first one is the branch this commit continues */
  parents: string[]
}

export interface GitCommitDetail {
  sha: string
  short: string
  subject: string
  body: string
  at: string
  author: string
  email: string
  refs: string[]
  files: GitFile[]
  stat: string
}

export interface GitBranch {
  name: string
  upstream: string | null
  ahead: number
  behind: number
  current: boolean
  at: string
  subject: string
}

export interface GitStatus {
  root: string
  branch: string
  /** branch this one is compared against, null when there is nothing sensible to compare to */
  base: string | null
  ahead: number
  /** the remote branch this one tracks, null when it has never been pushed */
  upstream: string | null
  /** commits on this branch that the remote does not have */
  unpushed: number
  unpushedCommits: GitCommit[]
  behind: number
  staged: GitFile[]
  unstaged: GitFile[]
  committed: GitFile[]
}

export interface UsageLimit {
  key: string
  label: string
  kind: string
  percent: number
  severity: string
  resetsAt: string | null
  active: boolean
}

export interface UsageStats {
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
  firstSessionDate: string | null
  daily: Array<{ date: string; messages: number; sessions: number; toolCalls: number }>
  models: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number }>
}

/** Context in use by one session, straight from the payload it hands its status line. */
export interface UsageContext {
  percent: number
  tokens: number
  size: number
  at: number
}

export interface UsageSnapshot {
  /** when these numbers were last written, whatever the source */
  fetchedAt: number | null
  /** true when they came from a live status-line payload rather than the cache in ~/.claude.json */
  live: boolean
  limits: UsageLimit[]
  /** by session id, for whichever sessions have rendered a status line recently */
  contexts: Record<string, UsageContext>
  stats: UsageStats | null
  /** caveman intensity from its flag file, null when the skill is off */
  caveman: string | null
}

export interface MergePlan {
  ok: boolean
  reason: string | null
  branch: string
  into: string
  commits: number
  files: number
  fastForward: boolean
  /** the checkout the merge would run in, which is where the target branch lives */
  at: string | null
}

export interface ApplyPlan {
  ok: boolean
  reason: string | null
  branch: string
  into: string
  /** files the patch touches */
  files: number
  /** files that exist only in the worktree and are copied across */
  untracked: number
  at: string | null
  /** uncommitted files already in the target, which the applied changes will sit beside */
  dirtyTarget: number
  /** files dirty in the target checkout that this patch also rewrites: applying would mix the two */
  overlaps: string[]
}

/** One line of the ship checklist: what will happen, or why it cannot. */
export interface ShipStep {
  key: string
  title: string
  detail: string
  /** run = will happen · skip = already true · block = stops the ship · warn = happens, but notable */
  state: 'run' | 'skip' | 'block' | 'warn'
}

/** Everything between "the agent is done" and "origin/main has it", checked before anything moves. */
export interface ShipPlan {
  ok: boolean
  branch: string
  into: string
  /** the checkout `into` lives in — where the merge and the push run */
  at: string | null
  remote: string | null
  commits: number
  files: number
  /** uncommitted paths in the agent's worktree, which ship commits for you */
  dirty: string[]
  /** uncommitted paths in the main checkout, which ship stashes and puts back */
  hostDirty: string[]
  /** how far the main checkout trails its remote */
  behind: number
  /** files that would collide, found without touching either checkout */
  conflicts: string[]
  steps: ShipStep[]
}

/** One step crossing the wire while ship runs, so the UI fills the timeline in as it happens. */
export interface ShipEvent {
  key: string
  title: string
  /** true when the step has finished; while false it is the one currently running */
  done: boolean
  ok?: boolean
  text?: string
  ms?: number
}

export interface ShipEntry {
  key: string
  title: string
  ok: boolean
  text: string
  ms: number
}

/** What builds after the push, so the user knows the change is on its way without guessing. */
export interface ShipDeploy {
  name: string
  detail: string
  url: string
}

export interface ShipResult {
  ok: boolean
  log: ShipEntry[]
  deploy: ShipDeploy | null
  /** the commit now on the remote base branch, which is what a deploy builds */
  sha: string | null
  url: string | null
}

/** One thing the main checkout has that a worktree needs; `copy` for config, `link` for deps. */
export interface SeedItem {
  path: string
  kind: 'copy' | 'link'
  size: number
  /** already in the worktree, so carrying it again would do nothing */
  present: boolean
}

export interface SeedPlan {
  repoPath: string
  worktree: string
  items: SeedItem[]
}
