import { useEffect, useState } from 'react'
import type { Agent, Session } from '../../../shared/types'
import { BrowserPane } from '../browser/BrowserPane'
import { GitPane } from '../git/GitPane'
import { onOpenLink } from '../state/openLink'
import { Commands } from './Commands'

type Tab = 'browser' | 'git' | 'commands'

// the browser is a native view, so only one of these may be mounted at a time: unmounting the
// browser pane is what parks its Chromium view out of the way
export function RightPanel({ s, agent }: { s: Session; agent: Agent | null }): JSX.Element {
  const [tab, setTab] = useState<Tab>(agent?.browser ? 'browser' : 'git')

  // a link clicked in the chat lands here: show the browser, then send it there. Navigating first
  // would load the page into a view that is still parked at 1x1 and paints nothing.
  useEffect(() => {
    return onOpenLink((id, url) => {
      if (!agent || id !== agent.id) return
      setTab('browser')
      void window.api.browserNavigate(agent.id, url)
    })
  }, [agent])
  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col bg-[var(--panel)]">
      <div className="flex shrink-0 items-center gap-0 border-b border-[var(--line)] px-2">
        <TabButton on={tab === 'browser'} onClick={() => setTab('browser')}>
          browser
        </TabButton>
        <TabButton on={tab === 'git'} onClick={() => setTab('git')}>
          git
        </TabButton>
        <TabButton on={tab === 'commands'} onClick={() => setTab('commands')}>
          commands{s.commands.length ? ` ${s.commands.length}` : ''}
        </TabButton>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'browser' ? (
          <BrowserPane agent={agent} />
        ) : tab === 'git' ? (
          <GitPane cwd={s.cwd} repoPath={s.repoPath} />
        ) : (
          <div className="h-full max-w-[520px] overflow-auto">
            {s.commands.length ? (
              <Commands list={s.commands} now={Date.now()} />
            ) : (
              <div className="px-4 py-3 text-[11px] text-[var(--dim)]">
                no slash commands in this session yet
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`lbl border-b-2 px-3 py-2 ${on ? 'border-[var(--accent)] !text-[var(--fg)]' : 'border-transparent hover:!text-[var(--muted)]'}`}
    >
      {children}
    </button>
  )
}
