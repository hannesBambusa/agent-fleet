import type { Session, UsageSnapshot } from '../../../shared/types'
import { tokens } from '../lib/format'
import { SCALE_LABELS, SCALES } from '../state/uiScale'
import { UsageStrip } from './UsageStrip'
import { ThemeMenu } from './ThemeMenu'
import type { Theme } from '../state/theme'

interface Props {
  sessions: Session[]
  hooksInstalled: boolean | null
  onInstallHooks: () => void
  onNew: () => void
  crumb?: string | null
  onBack?: () => void
  scale: number
  onScale: (v: number) => void
  usage: UsageSnapshot | null
  contextSession: Session | null
  theme: Theme
  onTheme: (id: string) => void
}

export function TopBar({ sessions, hooksInstalled, onInstallHooks, onNew, crumb, onBack, scale, onScale, usage, contextSession, theme, onTheme }: Props): JSX.Element {
  // the counts that used to sit in a stat row are already on the cards, the rail and the usage tab;
  // only "someone needs you" is worth repeating, because it is the one you must not miss
  const waiting = sessions.filter((s) => s.state === 'waiting').length

  return (
    <div className="shrink-0 border-b border-[var(--line)]">
      <div className="drag flex h-11 items-center pl-[84px] pr-4">
        <div className="lbl">agent fleet / {crumb ? 'agent' : 'live fleet'}</div>
        <div className="no-drag ml-4 flex items-baseline gap-2 text-[15px] font-semibold tracking-tight">
          {crumb && onBack ? (
            <>
              <button onClick={onBack} className="text-[var(--muted)] hover:text-[var(--fg)]">
                // fleet
              </button>
              <span className="text-[var(--dim)]">/</span>
              <span>{crumb}</span>
            </>
          ) : (
            <span>// AGENT FLEET</span>
          )}
        </div>
        <div className="no-drag ml-auto flex items-center gap-3">
          {waiting > 0 && <span className="chip chip-waiting dot-blink">{waiting} waiting for you</span>}
          {hooksInstalled === false && (
            <button onClick={onInstallHooks} className="chip chip-waiting hover:brightness-110" title="Without hooks, 'waiting for you' cannot be detected">
              install hooks
            </button>
          )}
          <span className="flex items-center gap-0.5" title="interface size (the terminal keeps its own)">
            <span className="lbl mr-1">size</span>
            {SCALES.map((v, i) => (
              <button
                key={v}
                onClick={() => onScale(v)}
                className={`lbl rounded px-1 py-0.5 ${v === scale ? 'bg-[var(--accent-soft)] !text-[var(--accent)]' : 'hover:!text-[var(--fg)]'}`}
              >
                {SCALE_LABELS[i]}
              </button>
            ))}
          </span>
          <ThemeMenu theme={theme} onPick={onTheme} />
          <button onClick={onNew} className="chip chip-running hover:brightness-110" title="new agent (⌘N)">
            + new agent
          </button>
        </div>
      </div>
      <UsageStrip snap={usage} session={contextSession} />
    </div>
  )
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'warn' }): JSX.Element {
  const c = tone === 'ok' ? 'text-[var(--accent)]' : tone === 'warn' ? 'text-[var(--warn)]' : 'text-[var(--fg)]'
  return (
    <div className="border-r border-[var(--line)] px-4 py-2 last:border-r-0">
      <div className="lbl">{k}</div>
      <div className={`mono mt-0.5 truncate text-[12px] ${c}`}>{v}</div>
    </div>
  )
}
