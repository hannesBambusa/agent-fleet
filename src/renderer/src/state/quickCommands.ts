import { useCallback, useEffect, useState } from 'react'

const KEY = 'agent-fleet.quickCommands'
const EVENT = 'agent-fleet:quick-commands'

// the review loop, which is what most sessions do most of the time
const DEFAULT = ['/git-add', '/preflight', '/fix-issues', '/commit', '/commit skip']

/**
 * The buttons above the chat composer.
 *
 * Which commands are worth one click is personal and changes with the project, so the list is the
 * user's, edited from the command catalog rather than hardcoded here. Stored per machine; the
 * commands themselves live in ~/.claude and are only referenced by name.
 */
export function readQuick(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : DEFAULT
  } catch {
    return DEFAULT
  }
}

function write(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // storage unavailable: the list simply does not persist
  }
  // the catalog and the composer are far apart in the tree, and both have to follow the change
  window.dispatchEvent(new CustomEvent(EVENT))
}

/** Commands are stored with their leading slash, the way they are typed. */
export function normalise(name: string): string {
  return name.startsWith('/') ? name : `/${name}`
}

export function toggleQuick(name: string): void {
  const cmd = normalise(name)
  const list = readQuick()
  write(list.includes(cmd) ? list.filter((c) => c !== cmd) : [...list, cmd])
}

export function useQuick(): string[] {
  const [list, setList] = useState(readQuick)
  const sync = useCallback(() => setList(readQuick()), [])
  useEffect(() => {
    window.addEventListener(EVENT, sync)
    // another window of the same app writes storage rather than dispatching into this one
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [sync])
  return list
}
