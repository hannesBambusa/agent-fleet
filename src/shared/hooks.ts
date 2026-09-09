import type { SessionState } from './types'

/**
 * What a hook event says about a session's state, or null when it says nothing.
 *
 * One definition, used by the main process when a hook arrives and by the renderer when it has to
 * judge an agent whose transcript does not exist yet. Two copies of this drifted once already, and
 * the drift is invisible: the fleet card and the chat simply disagree about whether an agent works.
 *
 * SessionStart is deliberately absent. It fires on startup, resume, `/clear` and compaction, when
 * the session is waiting for a prompt, and claiming "running" for it painted every freshly opened
 * agent green.
 */
export function claimFor(event: string, notificationType?: string): SessionState | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'running'
    case 'Notification':
      return notificationType === 'permission_prompt' ? 'waiting' : 'idle'
    case 'Stop':
      return 'idle'
    case 'SessionEnd':
      return 'ended'
    default:
      return null
  }
}

/** How long a claim stays believable: work goes stale fast, quiet can stand. */
export const CLAIM_RUN_MS = 45 * 1000
export const CLAIM_IDLE_MS = 10 * 60 * 1000
