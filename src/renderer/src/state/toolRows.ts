import { createBroadcastState } from './store'
import { useBroadcast } from './persist'

/**
 * Whether a tool call in the chat starts open.
 *
 * Reading a turn and skimming one are different jobs: following an agent live, the diffs are the
 * point and clicking each row is friction; catching up on a long turn, the same diffs are a wall.
 * The choice is per person, not per row, and each row can still be opened or closed on its own.
 */
const state = createBroadcastState<boolean>('toolRowsOpen', false, (v) => typeof v === 'boolean')

export function readToolRows(): boolean {
  return state.read()
}

export function toggleToolRows(): void {
  state.write(!state.read())
}

export function useToolRows(): boolean {
  return useBroadcast(state)
}
