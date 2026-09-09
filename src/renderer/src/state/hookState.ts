import { useEffect, useRef, useState } from 'react'
import type { HookEvent, SessionState } from '../../../shared/types'

import { CLAIM_IDLE_MS, CLAIM_RUN_MS, claimFor } from '../../../shared/hooks'

/**
 * What Claude Code itself last said about a session, keyed by session id.
 *
 * A freshly launched agent has no transcript for a second or two, and the fleet used to paint it
 * running for a full minute on the theory that a new agent is probably busy. It usually is not: an
 * agent launched without a prompt is sitting at an empty composer. Claude Code knows which it is and
 * says so through the hooks, and those arrive keyed by the session id the app chose at launch, long
 * before the transcript file exists.
 */
export function claim(e: HookEvent): SessionState | null {
  return claimFor(e.event, e.notification_type)
}

export interface HookClaim {
  state: SessionState
  at: number
}

/** Still worth believing? A running claim goes stale fast; an idle one can stand for a while. */
export function fresh(c: HookClaim | undefined, now: number): SessionState | null {
  if (!c) return null
  const age = now - c.at
  if (c.state === 'running' || c.state === 'waiting') return age < CLAIM_RUN_MS ? c.state : null
  return age < CLAIM_IDLE_MS ? c.state : null
}

export function useHookClaims(): Map<string, HookClaim> {
  const [claims, setClaims] = useState<Map<string, HookClaim>>(new Map())
  const buf = useRef<Map<string, HookClaim>>(new Map())
  useEffect(() => {
    const off = window.api.hooks.onHookEvent((e: HookEvent) => {
      const state = claim(e)
      if (state) buf.current.set(e.session_id, { state, at: Date.parse(e.at) || Date.now() })
    })
    // hooks can arrive several times a second while an agent works; batch them like pty activity
    const t = setInterval(() => {
      if (!buf.current.size) return
      const batch = buf.current
      buf.current = new Map()
      setClaims((prev) => {
        const next = new Map(prev)
        for (const [id, c] of batch) next.set(id, c)
        return next
      })
    }, 400)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])
  return claims
}
