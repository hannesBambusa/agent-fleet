import { useEffect, useState } from 'react'
import type { SlashCommand } from '../../../shared/types'

/**
 * The slash commands a session in `cwd` can use.
 *
 * Fetched once per directory and then left alone: commands are files someone edits between sessions,
 * not state that moves while the composer is open, and the main process caches the scan anyway.
 */
export function useSlashCommands(cwd: string | null): SlashCommand[] {
  const [list, setList] = useState<SlashCommand[]>([])
  useEffect(() => {
    if (!cwd) {
      setList([])
      return
    }
    let alive = true
    void window.api.slashCommands(cwd).then((c) => {
      if (alive) setList(c)
    })
    return () => {
      alive = false
    }
  }, [cwd])
  return list
}
