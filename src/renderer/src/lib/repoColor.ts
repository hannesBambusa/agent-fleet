/**
 * A colour per repo, so a glance at the fleet says which work belongs together. Identity only:
 * state keeps its own green and amber, and the repo hue never competes with it.
 *
 * The eight hues pass the categorical checks (lightness band, chroma floor, colour-vision
 * separation, contrast) against the app's dark surface.
 */
export const REPO_COLORS = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#c98500', '#2aa9a0', '#b06fc4', '#e34948']

const KEY = 'agent-fleet.repoColors'

/**
 * A chosen colour is either one of the eight above, by index, or any colour at all, as a hex string.
 * The index form is what earlier versions wrote, and is still read so nobody loses their choices.
 */
type Choice = number | string

function overrides(): Record<string, Choice> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Choice>
  } catch {
    return {}
  }
}

export function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
}

function hash(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

export function repoColor(repoPath: string): string {
  const chosen = overrides()[repoPath]
  if (isHex(chosen)) return chosen
  if (typeof chosen === 'number' && REPO_COLORS[chosen]) return REPO_COLORS[chosen]
  return REPO_COLORS[hash(repoPath) % REPO_COLORS.length]
}

/** Whether this repo is on a colour someone picked, as opposed to the one it was dealt. */
export function repoColorChosen(repoPath: string): boolean {
  return overrides()[repoPath] !== undefined
}

export function repoColorIndex(repoPath: string): number {
  const chosen = overrides()[repoPath]
  if (typeof chosen === 'number' && REPO_COLORS[chosen]) return chosen
  return hash(repoPath) % REPO_COLORS.length
}

export function setRepoColor(repoPath: string, choice: Choice | null): void {
  const next = { ...overrides() }
  // null puts it back to the colour the repo's own name works out to
  if (choice === null) delete next[repoPath]
  else next[repoPath] = choice
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage unavailable
  }
  window.dispatchEvent(new CustomEvent('agent-fleet:repo-colors'))
}
