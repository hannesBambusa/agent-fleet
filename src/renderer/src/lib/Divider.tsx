import { useCallback } from 'react'
import { holdOverlay } from '../state/overlay'

interface Props {
  /** distance dragged since the grab, in the layout's own pixels (zoom already divided out) */
  onDrag: (delta: number) => void
  /** capture whatever size the drag starts from */
  onStart?: () => void
  onEnd?: () => void
  onDoubleClick?: () => void
  title?: string
  /** 'x' splits columns and drags sideways, 'y' splits rows and drags up and down */
  axis?: 'x' | 'y'
}

/**
 * Reports a delta rather than an absolute position. Pointer coordinates and element rectangles do
 * not share a coordinate space once the interface is zoomed, and mixing them makes the pane jump to
 * wherever the mismatch lands the moment you grab the handle. A delta starts at zero by definition.
 *
 * Two things make a drag survive this app in particular. The browser pane is a native view that eats
 * every pointer event over it, so the drag parks it for its duration — otherwise crossing it loses
 * the moves and the mouseup, leaving the handle stuck to the pointer and the cursor stuck as a
 * resize arrow. And the cursor override is undone by every exit, including the ones nobody plans
 * for: pointer capture lost, the window blurred, the drag cancelled.
 */
export function Divider({ onDrag, onStart, onEnd, onDoubleClick, title, axis = 'x' }: Props): JSX.Element {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1
      const from = axis === 'x' ? e.clientX : e.clientY
      const release = holdOverlay()
      onStart?.()
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      el.setPointerCapture(e.pointerId)

      const move = (ev: PointerEvent): void => {
        onDrag(((axis === 'x' ? ev.clientX : ev.clientY) - from) / zoom)
      }
      const stop = (): void => {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        el.releasePointerCapture?.(e.pointerId)
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', stop)
        el.removeEventListener('pointercancel', stop)
        el.removeEventListener('lostpointercapture', stop)
        window.removeEventListener('blur', stop)
        release()
        onEnd?.()
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', stop)
      el.addEventListener('pointercancel', stop)
      el.addEventListener('lostpointercapture', stop)
      window.addEventListener('blur', stop)
    },
    [onDrag, onStart, onEnd, axis]
  )

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title={title ?? 'drag to resize'}
      className={
        axis === 'x'
          ? 'group relative w-[6px] shrink-0 cursor-col-resize border-l border-[var(--line)] hover:bg-[var(--accent-soft)]'
          : 'group relative h-[6px] shrink-0 cursor-row-resize border-t border-[var(--line)] hover:bg-[var(--accent-soft)]'
      }
    >
      <div
        className={
          axis === 'x'
            ? 'absolute inset-y-0 left-[2px] w-px bg-transparent group-hover:bg-[var(--accent)]'
            : 'absolute inset-x-0 top-[2px] h-px bg-transparent group-hover:bg-[var(--accent)]'
        }
      />
    </div>
  )
}
