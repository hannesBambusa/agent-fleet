const EVENT = 'agent-fleet:handoff'

/**
 * Handing a file to an agent in another repository.
 *
 * The pattern this exists for: one agent writes up what it found, and the work itself belongs
 * somewhere else. Today that means copying a path, opening a terminal in the other repo, starting
 * Claude Code and explaining the context by hand. All of that is known already.
 */
export function handoff(path: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { path } }))
}

export function onHandoff(cb: (path: string) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<{ path: string }>).detail
    if (d?.path) cb(d.path)
  }
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}

// Long enough for a handoff note, short enough that the receiving agent is not handed a novel it
// must read before it can start. Past this the file is referenced by path instead of pasted.
export const INLINE_LIMIT = 12_000

/**
 * Where the copy lands, relative to wherever the agent ends up working.
 *
 * Always copied, whether or not the text was also pasted into the prompt: the agent may want to
 * re-read it, and a path into another repository is both a permission prompt and a file that can
 * move underneath it. Living in the worktree also means it is thrown away with the worktree, and a
 * folder of briefs is easy to clear out by hand until then.
 */
export function handoffAt(path: string): string {
  return `.claude/handoff/${path.split('/').pop() ?? path}`
}

/** The prompt the new agent wakes up to. */
export function handoffPrompt(note: string, file: { path: string; text: string }, from: string): string {
  const name = file.path.split('/').pop() ?? file.path
  const task = note.trim() || 'Pick this up.'
  if (file.text.length <= INLINE_LIMIT) {
    return [
      task,
      '',
      `Context, handed over from ${from} (${name}), also saved as ${handoffAt(file.path)}:`,
      '',
      '```',
      file.text.trim(),
      '```'
    ].join('\n')
  }
  // Relative on purpose: the app copies the document into the agent's own directory, and the
  // worktree it lands in has a generated name nobody knows at this point.
  return [
    task,
    '',
    `The brief for this, handed over from ${from}, is ${handoffAt(file.path)} in this working ` +
      `directory. Read it first, then start.`
  ].join('\n')
}
