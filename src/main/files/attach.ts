import { app, dialog, nativeImage } from 'electron'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = (): string => join(app.getPath('userData'), 'attachments')
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Somewhere to put an image so an agent can read it.
 *
 * Claude Code takes an image as a path in the prompt, so a screenshot pasted into the composer has
 * to land on disk before it can be mentioned. These live outside the user's repositories on purpose:
 * a pasted screenshot is not part of the project, and dropping it in the worktree would put it in
 * the diff the agent is about to commit.
 */
function dir(): string {
  const d = DIR()
  mkdirSync(d, { recursive: true })
  return d
}

/** Old attachments are of no use to anyone once the conversation has moved on. */
function prune(): void {
  const now = Date.now()
  for (const name of readdirSync(DIR())) {
    const file = join(DIR(), name)
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true })
    } catch {
      // a file that vanished under us needs no pruning
    }
  }
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

export function saveImage(bytes: Uint8Array, mime: string): string {
  const d = dir()
  prune()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(d, `${stamp}.${EXT[mime] ?? 'png'}`)
  writeFileSync(file, bytes)
  return file
}

/**
 * A small preview of an image on disk, as a data URL.
 *
 * The composer shows what you attached rather than a wall of paths, and the renderer cannot read the
 * filesystem, so the picture has to come across the wire. Resized to thumbnail height first: a full
 * screenshot base64-encoded is megabytes of string for something drawn 40 pixels tall.
 */
export function thumbnail(path: string): string | null {
  try {
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return null
    return img.resize({ height: 80, quality: 'good' }).toDataURL()
  } catch {
    return null
  }
}

/** The file picker, for an image the user already has somewhere. Its own path is handed back as is. */
export async function pickImage(): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Attach an image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  })
  return canceled ? null : (filePaths[0] ?? null)
}
