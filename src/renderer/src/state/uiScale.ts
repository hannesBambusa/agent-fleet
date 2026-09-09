import { useCallback, useEffect, useState } from 'react'

const KEY = 'agent-fleet.uiScale'
export const SCALES = [0.85, 0.925, 1, 1.1, 1.25, 1.4]
export const SCALE_LABELS = ['XS', 'S', 'M', 'L', 'XL', 'XXL']

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    if (SCALES.includes(v)) return v
  } catch {
    // storage unavailable
  }
  return 1
}

/**
 * Scales the whole interface with CSS zoom on the root. The terminal cancels it again so its own
 * font size stays where xterm put it: a zoomed terminal reflows the pty and fights Claude Code's TUI.
 */
export function useUiScale(): { scale: number; setScale: (v: number) => void } {
  const [scale, set] = useState(read)
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(scale))
  }, [scale])
  const setScale = useCallback((v: number) => {
    set(v)
    try {
      localStorage.setItem(KEY, String(v))
    } catch {
      // storage unavailable
    }
  }, [])
  return { scale, setScale }
}
