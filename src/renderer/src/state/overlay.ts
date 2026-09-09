import { useEffect } from 'react'

/**
 * The browser pane is a native Chromium view, so it always paints above the page: no menu, dropdown
 * or dialog can be drawn on top of it. Anything that opens over the app parks the view first.
 */
const EVENT = 'agent-fleet:overlay'
let open = 0

export function overlaysOpen(): boolean {
  return open > 0
}

function announce(): void {
  window.dispatchEvent(new CustomEvent(EVENT))
}

export function onOverlayChange(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}

/** hold the native view out of the way for as long as this component is mounted */
export function useOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return
    open += 1
    announce()
    return () => {
      open -= 1
      announce()
    }
  }, [active])
}
