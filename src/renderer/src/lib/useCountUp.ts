import { useEffect, useRef, useState } from 'react'

/**
 * Eases a number towards its real value instead of snapping to it. The transcript arrives in bursts,
 * so a token count would otherwise jump from 1.2k to 2.8k in one frame; this walks it up. It never
 * overshoots the real figure, so the number on screen is always one the session has actually reached.
 */
export function useCountUp(target: number, ms = 700): number {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  const startedAt = useRef(0)
  const raf = useRef(0)

  useEffect(() => {
    if (target === shown) return
    // a reset (new turn) should not animate down from the previous turn's total
    if (target < shown) {
      setShown(target)
      from.current = target
      return
    }
    from.current = shown
    startedAt.current = performance.now()
    const step = (t: number): void => {
      const p = Math.min(1, (t - startedAt.current) / ms)
      const eased = 1 - Math.pow(1 - p, 3)
      setShown(Math.round(from.current + (target - from.current) * eased))
      if (p < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [target, ms])

  return shown
}
