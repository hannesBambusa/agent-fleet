import { useCallback } from 'react'

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
 */
export function Divider({ onDrag, onStart, onEnd, onDoubleClick, title, axis = 'x' }: Props): JSX.Element {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1
      const from = axis === 'x' ? e.clientX : e.clientY
      onStart?.()
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      const move = (ev: MouseEvent): void => {
        const at = axis === 'x' ? ev.clientX : ev.clientY
        onDrag((at - from) / zoom)
      }
      const up = (): void => {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        onEnd?.()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [onDrag, onStart, onEnd, axis]
  )
  return (
    <div
      onMouseDown={onMouseDown}
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
