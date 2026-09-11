/**
 * The word Claude Code is using for what it is doing right now.
 *
 * It picks one itself — Mustering, Pondering, Noodling — and prints it in its own terminal as
 * `✻ Mustering… (12s · ↑ 1.4k tokens)`. That word never reaches the transcript, so the chat used to
 * invent its own from a list, and the two disagreed in front of you. This reads the real one out of
 * the terminal the app already owns.
 *
 * Chunks arrive mid-word and full of escape codes, so a short tail per agent is kept and stripped
 * before matching. Nothing is parsed beyond the verb: the rest of that line is a timer the chat
 * already draws itself.
 */
const TAIL = 600
const ANSI = /\[[0-9;?]*[a-zA-Z]|\][^]*|\r/g
// the spinner glyph rotates, so it is not part of the match: a capitalised word, then an ellipsis
const VERB = /([A-Z][a-z]{2,14})(?:…|\.\.\.)\s*\(/g

export function verbIn(text: string): string | null {
  const clean = text.replace(ANSI, '')
  let found: string | null = null
  for (const m of clean.matchAll(VERB)) found = m[1]
  return found
}
