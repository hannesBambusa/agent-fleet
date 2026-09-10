import { useEffect, useRef } from 'react'
import { repoColor, repoColorChosen, REPO_COLORS, setRepoColor } from '../lib/repoColor'

// A ring of hues at two lightnesses: enough to find "the green one" or "a warmer blue" by eye,
// without asking anyone to reason about a colour space. Anything more exact goes through the
// system picker below.
const HUES = [0, 20, 40, 60, 90, 140, 170, 195, 215, 240, 270, 300, 330]
const SHADES = [
  { s: 62, l: 58 },
  { s: 45, l: 40 }
]

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h} ${s}% ${l}%)`
}

/** The picker needs hex, and a swatch is easier to define in hsl; this is the bridge. */
function hslHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n: number): string => {
    const k = (n + h / 30) % 12
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/**
 * Pick a colour for a repository.
 *
 * Three ways, in the order people actually want them: the eight the app already uses, which are
 * checked for colour-vision separation and are the right answer most of the time; a spread of hues
 * for when you simply want "the purple one"; and the system colour picker for an exact value, since
 * nothing hand-built competes with it.
 */
export function ColorPicker({ repoPath, onClose }: { repoPath: string; onClose: () => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const current = repoColor(repoPath)
  // Deliberately not parking the browser pane. Anything drawn over the app has to move that native
  // view aside, because it always paints on top — but this opens inside the fleet panel, which is
  // left of the divider and never overlaps it. Parking here just blanked the page you were watching.

  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const pick = (value: string | number): void => {
    setRepoColor(repoPath, value)
    onClose()
  }

  return (
    <div
      ref={box}
      onClick={(e) => e.stopPropagation()}
      className="absolute left-0 top-[calc(100%+6px)] z-50 w-[212px] rounded-md border border-[var(--line)] bg-[var(--panel)] p-2 shadow-2xl"
    >
      <div className="lbl mb-1.5">the eight</div>
      <div className="mb-2.5 flex flex-wrap gap-1">
        {REPO_COLORS.map((c, i) => (
          <Swatch key={c} color={c} on={current.toLowerCase() === c.toLowerCase()} onClick={() => pick(i)} />
        ))}
      </div>

      <div className="lbl mb-1.5">or any of these</div>
      <div className="mb-2.5 flex flex-col gap-1">
        {SHADES.map((sh) => (
          <div key={sh.l} className="flex gap-1">
            {HUES.map((h) => {
              const hex = hslHex(h, sh.s, sh.l)
              return (
                <Swatch
                  key={h}
                  color={hsl(h, sh.s, sh.l)}
                  on={current.toLowerCase() === hex}
                  onClick={() => pick(hex)}
                  small
                />
              )
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5" title="pick an exact colour">
          <input
            type="color"
            value={current}
            onChange={(e) => setRepoColor(repoPath, e.target.value.toLowerCase())}
            className="h-[18px] w-[26px] cursor-pointer rounded border border-[var(--line)] bg-transparent p-0"
          />
          <span className="lbl">exact</span>
        </label>
        {repoColorChosen(repoPath) && (
          <button
            onClick={() => {
              setRepoColor(repoPath, null)
              onClose()
            }}
            className="lbl ml-auto hover:!text-[var(--accent)]"
          >
            reset
          </button>
        )}
      </div>
    </div>
  )
}

function Swatch({
  color,
  on,
  onClick,
  small
}: {
  color: string
  on: boolean
  onClick: () => void
  small?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={color}
      className="rounded-full transition-transform hover:scale-125"
      style={{
        background: color,
        width: small ? 12 : 16,
        height: small ? 12 : 16,
        // the ring says which one is on, without changing the swatch's own colour
        outline: on ? '2px solid var(--fg)' : 'none',
        outlineOffset: '1px'
      }}
    />
  )
}
