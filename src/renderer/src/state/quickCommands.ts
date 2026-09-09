import { createBroadcastState } from './store'
import { useBroadcast } from './persist'

// the review loop, which is what most sessions do most of the time
const DEFAULT = ['/git-add', '/preflight', '/fix-issues', '/commit', '/commit skip']

/**
 * The buttons above the chat composer.
 *
 * Which commands are worth one click is personal and changes with the project, so the list is the
 * user's, edited from the command catalog rather than hardcoded here. Stored per machine; the
 * commands themselves live in ~/.claude and are only referenced by name.
 */
const state = createBroadcastState<string[]>('quickCommands', DEFAULT, (v) => Array.isArray(v))

/** Commands are stored with their leading slash, the way they are typed. */
export function normalise(name: string): string {
  return name.startsWith('/') ? name : `/${name}`
}

export function readQuick(): string[] {
  return state.read().filter((x): x is string => typeof x === 'string')
}

export function toggleQuick(name: string): void {
  const cmd = normalise(name)
  const list = readQuick()
  state.write(list.includes(cmd) ? list.filter((c) => c !== cmd) : [...list, cmd])
}

export function useQuick(): string[] {
  return useBroadcast(state)
}
