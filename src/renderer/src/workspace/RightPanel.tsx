import { useEffect, useState } from 'react'
import type { Agent, Session } from '../../../shared/types'
import { BrowserPane } from '../browser/BrowserPane'
import { GitPane } from '../git/GitPane'
import { FilesPane } from '../files/FilesPane'
import { DevPane } from './DevPane'
import { onOpenLink } from '../state/openLink'
import { onOpenFile } from '../state/openFile'
import { usePersistedOneOf } from '../state/persist'
import { Commands } from './Commands'

type Tab = 'browser' | 'git' | 'files' | 'dev' | 'commands'

// the browser is a native view, so only one of these may be mounted at a time: unmounting the
// browser pane is what parks its Chromium view out of the way
export function RightPanel({ s, agent, width }: { s: Session; agent: Agent | null; width: number }): JSX.Element {
  // the pane you last worked in, except that an agent without a browser cannot show one
  const [saved, setTab] = usePersistedOneOf<Tab>('rightPanelTab', ['browser', 'git', 'files', 'dev', 'commands'], 'git')
  const tab: Tab = saved === 'browser' && agent && !agent.browser ? 'git' : saved

  // a link clicked in the chat lands here: show the browser, then send it there. Navigating first
  // would load the page into a view that is still parked at 1x1 and paints nothing.
  // a path mentioned in the chat opens here, in the file browser
  useEffect(() => {
    return onOpenFile(() => setTab('files'))
  }, [setTab])

  useEffect(() => {
    return onOpenLink((id, url) => {
      if (!agent || id !== agent.id) return
      setTab('browser')
      void window.api.browser.navigate(agent.id, url)
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
        <TabButton on={tab === 'files'} onClick={() => setTab('files')}>
          files
        </TabButton>
        <TabButton on={tab === 'dev'} onClick={() => setTab('dev')}>
          dev
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
        ) : tab === 'files' ? (
          <FilesPane root={s.cwd} width={width} />
        ) : tab === 'dev' ? (
          <DevPane repoPath={s.repoPath} cwd={s.cwd} agentId={agent?.id ?? null} />
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
