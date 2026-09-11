import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApplyPlan, GitCommit, GitFile, GitStatus, MergePlan } from '../../../shared/types'
import { DiffView } from './DiffView'
import { History } from './History'
import { Branches } from './Branches'
import { ShipPane } from './ShipPane'
import { SeedBand } from './SeedBand'
import { SimpleView } from './SimpleView'
import { age } from '../lib/format'
import { usePersistedOneOf } from '../state/persist'

const POLL_MS = 3000
// the plans cost a patch build and a dry-run apply, so they move on their own, slower clock
const PLAN_MS = 15000

interface Selection {
  path: string
  staged: boolean
  untracked: boolean
  base?: string
}

// the tab keys are what the code switches on; these are what they are called on screen
const TAB_LABEL: Record<string, string> = {
  changes: 'changes',
  ship: 'ship',
  history: 'commit graph',
  branches: 'branches'
}

const letterColor: Record<string, string> = {
  M: 'text-[#e0af68]',
  A: 'text-[#8bf0bd]',
  D: 'text-[#ff9b93]',
  R: 'text-[#7aa2f7]',
  C: 'text-[#7aa2f7]',
  U: 'text-[var(--danger)]',
  '?': 'text-[var(--muted)]'
}

export function GitPane({ cwd, repoPath }: { cwd: string; repoPath: string }): JSX.Element {
  // a worktree agent usually needs to look at both: its own tree, and the checkout it merges into
  const [target, setTarget] = usePersistedOneOf<'worktree' | 'repo'>('gitTarget', ['worktree', 'repo'], 'worktree')
  const isWorktree = repoPath !== cwd
  const view = target === 'repo' && isWorktree ? repoPath : cwd
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  // The checkout the work has to end up in. A worktree cannot answer whether its branch landed there
  // or whether that checkout has pushed, and being unable to see it is what makes work feel lost.
  const [host, setHost] = useState<GitStatus | null>(null)
  /** the agent's own tree, kept regardless of which checkout the tabs below are showing */
  const [wt, setWt] = useState<GitStatus | null>(null)
  // status is null both before the first answer and when there is no repository; only this tells
  // the two apart, and without it the pane sits on "reading git status…" forever
  const [noRepo, setNoRepo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection | null>(null)
  const [diff, setDiff] = useState('')
  const seq = useRef(0)
  const msgRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // Two ways to read the same repository: guided, which answers "what do I do now", and the full
  // pane, which answers "what exactly is going on". The first is the one that stops a worktree
  // losing work; the second is the one that explains it.
  const [mode, setMode] = usePersistedOneOf<'simple' | 'advanced'>('gitMode', ['simple', 'advanced'], 'simple')
  // ship leads: the question a worktree raises first is where the work stands, not which lines moved
  const [tab, setTab] = usePersistedOneOf<'changes' | 'ship' | 'history' | 'branches'>(
    'gitTab',
    ['ship', 'changes', 'history', 'branches'],
    'ship'
  )
  const [confirmPush, setConfirmPush] = useState(false)
  const [pushing, setPushing] = useState(false)
  // outcome of the last action: red only when it actually failed
  const [pushMsg, setPushMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [merging, setMerging] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [branchName, setBranchName] = useState<string | null>(null)
  const [pushingBranch, setPushingBranch] = useState(false)
  const [headSubject, setHeadSubject] = useState<string | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [whyMerge, setWhyMerge] = useState(false)
  const [aplan, setAplan] = useState<ApplyPlan | null>(null)
  const [confirmApply, setConfirmApply] = useState(false)
  const [applying, setApplying] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // Both checkouts, every tick, whichever one the lists happen to be showing: the pipeline is
      // about the journey between them, so it cannot be driven by whatever the tabs are pointed at.
      const [w, h] = await Promise.all([
        window.api.git.status(cwd),
        isWorktree ? window.api.git.status(repoPath).catch(() => null) : Promise.resolve(null)
      ])
      setWt(w)
      setHost(h)
      const s = view === cwd ? w : h
      setStatus(s)
      setNoRepo(s === null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [view, cwd, isWorktree, repoPath])

  useEffect(() => {
    if (tab === 'ship' && target !== 'worktree') setTab('changes')
  }, [tab, target])

  // the plans decide what the merge, publish and copy buttons offer, so they have to keep pace with
  // the status they are drawn beside: fetched once, they went stale the moment the repo moved and the
  // buttons kept offering an action the plan no longer supported
  const reload = useCallback((): void => {
    void window.api.git.mergePlan(cwd).then(setPlan).catch(() => setPlan(null))
    void window.api.git.applyPlan(cwd).then(setAplan).catch(() => setAplan(null))
    void window.api.git.log(cwd).then((l) => setHeadSubject(l[0]?.subject ?? null)).catch(() => setHeadSubject(null))
  }, [cwd])

  useEffect(() => {
    setSel(null)
    setDiff('')
    setConfirmPush(false)
    setConfirmMerge(false)
    setConfirmPublish(false)
    setPushMsg(null)
    // a different directory is an open question again, whatever the last one turned out to be
    setNoRepo(false)
    // the pull-request url only changes when the branch or its upstream does, so it stays one-shot
    void window.api.git.prUrl(cwd).then(setPrUrl).catch(() => setPrUrl(null))
    reload()
    void refresh()
  }, [refresh, reload, view])

  // A directory does not become a repository while the pane is open, so once git has said it is not
  // one both clocks stop rather than re-asking a settled question every three seconds.
  useEffect(() => {
    if (noRepo) return
    const t = setInterval(() => void refresh(), POLL_MS)
    // a floor, for repo changes that leave the status untouched (a commit landing on the base branch)
    const p = setInterval(reload, PLAN_MS)
    return () => {
      clearInterval(t)
      clearInterval(p)
    }
  }, [noRepo, refresh, reload])


  // the diff is re-read on every poll so the pane follows the agent while it edits
  useEffect(() => {
    if (!sel) {
      setDiff('')
      return
    }
    const mine = ++seq.current
    void window.api
      .git.diff(view, sel.path, sel.staged, sel.untracked, sel.base)
      .then((d) => {
        if (mine === seq.current) setDiff(d)
      })
      .catch(() => {
        if (mine === seq.current) setDiff('')
      })
  }, [view, sel, status])

  const counts = useMemo(
    () => ({
      staged: status?.staged.length ?? 0,
      unstaged: status?.unstaged.length ?? 0,
      committed: status?.committed.length ?? 0
    }),
    [status]
  )
  // …and immediately whenever the status actually moved, which is what usually invalidates a plan.
  // Recomputing the apply plan means building a full patch and dry-running it, too expensive to do on
  // the 3 s status tick for its own sake.
  const shape = `${status?.branch}:${counts.staged}:${counts.unstaged}:${status?.unpushed}:${status?.behind}`
  const lastShape = useRef('')
  useEffect(() => {
    if (lastShape.current && lastShape.current !== shape) reload()
    lastShape.current = shape
  }, [shape, reload])

  async function stage(paths: string[], on: boolean): Promise<void> {
    try {
      await (on ? window.api.git.stage(view, paths) : window.api.git.unstage(view, paths))
      await refresh()
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message : String(err), ok: false })
    }
  }

  async function merge(): Promise<void> {
    if (!confirmMerge) {
      setConfirmMerge(true)
      return
    }
    setConfirmMerge(false)
    setMerging(true)
    setPushMsg(null)
    try {
      setPushMsg({ text: await window.api.git.merge(cwd), ok: true })
      await refresh()
      setPlan(await window.api.git.mergePlan(cwd))
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setMerging(false)
    }
  }

  async function apply(): Promise<void> {
    if (!confirmApply) {
      setConfirmApply(true)
      return
    }
    setConfirmApply(false)
    setApplying(true)
    setPushMsg(null)
    try {
      setPushMsg({ text: await window.api.git.apply(cwd), ok: true })
      await refresh()
      setAplan(await window.api.git.applyPlan(cwd))
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setApplying(false)
    }
  }

  // a name that reads well in a pull-request list, from the work itself
  function suggestName(): string {
    // once the branch has been pushed there is nothing "unpushed" left to name it after, so fall
    // back to the newest commit rather than to the generated branch name
    const subject = status?.unpushedCommits[0]?.subject ?? headSubject ?? status?.branch ?? 'work'
    const slug = subject
      .toLowerCase()
      .replace(/^[a-z]+(\([^)]*\))?:\s*/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-')
    return `agent/${slug || 'work'}`
  }

  async function doCommit(): Promise<void> {
    if (!message.trim()) return
    setCommitting(true)
    setPushMsg(null)
    try {
      setPushMsg({ text: await window.api.git.commitStaged(view, message), ok: true })
      setMessage('')
      await refresh()
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setCommitting(false)
    }
  }

  async function pushBranch(): Promise<void> {
    if (!branchName?.trim()) return
    setPushingBranch(true)
    setPushMsg(null)
    try {
      setPushMsg({ text: await window.api.git.pushBranch(cwd, branchName.trim()), ok: true })
      setBranchName(null)
      await refresh()
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message.split('\n').slice(-2).join(' ') : String(err), ok: false })
    } finally {
      setPushingBranch(false)
    }
  }

  async function publish(): Promise<void> {
    if (!confirmPublish) {
      setConfirmPublish(true)
      return
    }
    setConfirmPublish(false)
    setPublishing(true)
    setPushMsg(null)
    try {
      setPushMsg({ text: await window.api.git.publish(cwd), ok: true })
      await refresh()
      setPlan(await window.api.git.mergePlan(cwd))
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setPublishing(false)
    }
  }

  /** The other direction: what main gained since this branch was cut. */
  async function update(): Promise<void> {
    setMerging(true)
    setPushMsg(null)
    try {
      setPushMsg({ text: await window.api.git.update(cwd), ok: true })
      await refresh()
      reload()
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setMerging(false)
    }
  }

  async function push(): Promise<void> {
    if (!confirmPush) {
      setConfirmPush(true)
      return
    }
    setConfirmPush(false)
    setPushing(true)
    setPushMsg(null)
    try {
      await window.api.git.push(view)
      setPushMsg({ text: 'pushed', ok: true })
      await refresh()
    } catch (err) {
      setPushMsg({ text: err instanceof Error ? err.message.split('\n').slice(-2).join(' ') : String(err), ok: false })
    } finally {
      setPushing(false)
    }
  }

  if (noRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-[11px] text-[var(--dim)]">
        <span className="text-[var(--muted)]">not a git repository</span>
        <span>this session is running in a plain directory, so there is no git state to show</span>
        <span className="mono text-[9.5px]">{view}</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--dim)]">
        {error}
      </div>
    )
  }
  const modeBar = (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
      <span className="mono truncate text-[11px] text-[var(--accent)]">{wt?.branch ?? status?.branch ?? '—'}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {(['simple', 'advanced'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            title={m === 'simple' ? 'where the work is, and the next step' : 'every file, commit, branch and diff'}
            className={`lbl rounded px-1.5 py-0.5 ${
              mode === m ? 'bg-[var(--accent-soft)] !text-[var(--accent)]' : 'hover:!text-[var(--fg)]'
            }`}
          >
            {m === 'simple' ? 'guided' : 'everything'}
          </button>
        ))}
      </span>
    </div>
  )

  if (mode === 'simple') {
    return (
      <div className="flex h-full w-full min-w-0 max-w-[1080px] flex-1 flex-col bg-[var(--panel)]">
        {modeBar}
        <SimpleView
          wt={wt}
          host={host}
          plan={plan}
          worktree={isWorktree}
          busy={merging ? 'merging…' : pushing ? 'pushing…' : committing ? 'committing…' : null}
          message={message}
          onMessage={setMessage}
          onStage={() => void window.api.git.stage(cwd, (wt?.unstaged ?? []).map((f) => f.path)).then(refresh)}
          onCommit={() => {
            if (message.trim()) void doCommit()
          }}
          onMerge={() => void merge()}
          onUpdate={() => void update()}
          onFile={(f) => {
            // the diff lives in the full pane, so opening one takes the reader there
            setMode('advanced')
            setTarget('worktree')
            setTab('changes')
            setSel({ path: f.path, staged: f.staged, untracked: f.letter === '?' })
          }}
        />
        {pushMsg && (
          <div
            className={`mono shrink-0 truncate border-t border-[var(--line)] px-4 py-1.5 text-[10.5px] ${
              pushMsg.ok ? 'text-[var(--muted)]' : 'text-[var(--danger)]'
            }`}
            title={pushMsg.text}
          >
            {pushMsg.text}
          </div>
        )}
      </div>
    )
  }

  const empty = status && !counts.staged && !counts.unstaged && !counts.committed

  return (
    // Fills the pane until it gets wide, then stops: a file list and a diff read badly at 1600px.
    // Left aligned rather than centred, so the column stays where the eye already is when the panel
    // is resized and the pane does not appear to drift.
    <div className="flex h-full w-full min-w-0 max-w-[1080px] flex-1 flex-col bg-[var(--panel)]">
      {modeBar}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
        <span className="lbl">branch</span>
        <span className="mono truncate text-[11px]">{status?.branch ?? '—'}</span>
        <span className="mono ml-auto shrink-0 text-[10px] text-[var(--dim)]">
          {counts.staged} staged · {counts.unstaged} changed
          {status?.behind ? ` · ${status.behind} behind` : ''}
        </span>
        {aplan && (aplan.ok || aplan.files > 0 || aplan.untracked > 0) && (
          <button
            onClick={() => (aplan.ok ? void apply() : setWhyMerge(!whyMerge))}
            disabled={applying}
            title={
              aplan.ok
                ? `copy ${aplan.files} changed file(s)${aplan.untracked ? ` and ${aplan.untracked} new file(s)` : ''} into ${aplan.at}, uncommitted` +
                  (aplan.dirtyTarget ? ` · ${aplan.into} already has ${aplan.dirtyTarget} uncommitted file(s), none of them touched by this patch` : '')
                : (aplan.reason ?? '')
            }
            className={`chip shrink-0 ${confirmApply ? 'chip-waiting' : aplan.ok ? 'chip-running' : 'chip-idle'} hover:brightness-110 disabled:opacity-40`}
          >
            {applying
              ? 'applying…'
              : confirmApply
                ? `confirm copy → ${aplan.into}`
                : aplan.ok
                  ? `copy changes → ${aplan.into}`
                  : 'copy blocked'}
          </button>
        )}
        {prUrl && !!status?.upstream && (
          <button
            onClick={() => void window.api.shell.openExternal(prUrl)}
            title="open this branch's pull request page on GitHub, which also says whether it merges cleanly"
            className="chip shrink-0 hover:!text-[var(--accent)]"
          >
            pull request ↗
          </button>
        )}
        {!!plan?.commits && (
          <button
            onClick={() => setBranchName(branchName === null ? suggestName() : null)}
            title="push these commits to a new remote branch, then merge it however you like"
            className="chip chip-running shrink-0 hover:brightness-110"
          >
            push as branch
          </button>
        )}
        {plan?.ok && (
          <button
            onClick={() => void publish()}
            disabled={publishing || merging}
            title={`merge ${plan.commits} commit(s) into ${plan.into} and push it`}
            className={`chip shrink-0 ${confirmPublish ? 'chip-waiting' : 'chip-running'} hover:brightness-110 disabled:opacity-40`}
          >
            {publishing ? 'publishing…' : confirmPublish ? `confirm publish → ${plan.into}` : `publish → ${plan.into}`}
          </button>
        )}
        {plan && (
          <button
            onClick={() => (plan.ok ? void merge() : setWhyMerge(!whyMerge))}
            disabled={merging}
            title={
              plan.ok
                ? `${plan.fastForward ? 'fast-forward' : 'merge'} ${plan.commits} commit(s), ${plan.files} file(s) into ${plan.into} in ${plan.at}`
                : (plan.reason ?? '')
            }
            className={`chip shrink-0 ${confirmMerge ? 'chip-waiting' : plan.ok ? 'chip-running' : 'chip-idle'} hover:brightness-110 disabled:opacity-40`}
          >
            {merging
              ? 'merging…'
              : confirmMerge
                ? `confirm merge → ${plan.into}`
                : plan.ok
                  ? `merge only`
                  : `merge blocked · why${whyMerge ? ' ▴' : ' ▾'}`}
          </button>
        )}
        {!!status?.unpushed && (
          <button
            onClick={() => void push()}
            disabled={pushing}
            title={status.upstream ? `push to ${status.upstream}` : 'publish this branch to origin'}
            className={`chip shrink-0 ${confirmPush ? 'chip-waiting' : 'chip-running'} hover:brightness-110 disabled:opacity-40`}
          >
            {pushing ? 'pushing…' : confirmPush ? `confirm push ${status.unpushed}` : `push ${status.unpushed}`}
          </button>
        )}
      </div>

      {isWorktree && (
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line)] px-2 py-1.5">
          <span className="lbl mr-1">looking at</span>
          {(['worktree', 'repo'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTarget(t)}
              title={t === 'worktree' ? cwd : repoPath}
              className={`lbl rounded px-1.5 py-0.5 ${
                target === t ? 'bg-[var(--accent-soft)] !text-[var(--accent)]' : 'hover:!text-[var(--fg)]'
              }`}
            >
              {t === 'worktree' ? 'this agent' : 'main checkout'}
            </button>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-0 border-b border-[var(--line)] px-2">
        {((isWorktree && target === 'worktree'
          ? (['ship', 'changes', 'history', 'branches'] as const)
          : (['changes', 'history', 'branches'] as const)) as readonly typeof tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`lbl border-b-2 px-2.5 py-1.5 ${
              tab === t ? 'border-[var(--accent)] !text-[var(--fg)]' : 'border-transparent hover:!text-[var(--muted)]'
            }`}
          >
            {TAB_LABEL[t] ?? t}
          </button>
        ))}
        {tab === 'changes' && !!counts.unstaged && (
          <button
            onClick={() => void stage(status!.unstaged.map((f) => f.path), true)}
            className="lbl ml-auto rounded px-1.5 py-0.5 hover:!text-[var(--accent)]"
            title="git add every changed file"
          >
            stage all
          </button>
        )}
        {tab === 'changes' && !!counts.staged && (
          <button
            onClick={() => void stage(status!.staged.map((f) => f.path), false)}
            className={`lbl rounded px-1.5 py-0.5 hover:!text-[var(--danger)] ${counts.unstaged ? '' : 'ml-auto'}`}
            title="unstage everything"
          >
            unstage all
          </button>
        )}
      </div>

      {aplan && !aplan.ok && whyMerge && aplan.reason && (
        <div className="shrink-0 border-b border-[var(--line)] px-3 py-2 text-[10.5px]">
          <div className="text-[var(--warn)]">{aplan.reason}</div>
          <div className="mono mt-1.5 text-[9.5px] text-[var(--dim)]">
            copying {aplan.files} changed and {aplan.untracked} new file(s) into {aplan.at ?? 'no checkout'}
          </div>
        </div>
      )}

      {plan && !plan.ok && whyMerge && (
        <div className="shrink-0 border-b border-[var(--line)] px-3 py-2 text-[10.5px]">
          <div className="text-[var(--warn)]">{plan.reason ?? 'merge is not possible here'}</div>
          <div className="mono mt-1.5 space-y-0.5 text-[9.5px] text-[var(--dim)]">
            <div>
              branch <span className="text-[var(--muted)]">{plan.branch}</span> → into{' '}
              <span className="text-[var(--muted)]">{plan.into || '—'}</span>
            </div>
            <div>
              {plan.commits} commit{plan.commits === 1 ? '' : 's'} · {plan.files} file{plan.files === 1 ? '' : 's'} ahead
            </div>
            <div>would run in {plan.at ?? 'no checkout holds the target branch'}</div>
            {aplan?.ok && (
              <div className="text-[var(--muted)]">
                copy changes → {aplan.into} still works: it applies the files instead of the commits
              </div>
            )}
          </div>
          <button
            onClick={() => void window.api.git.mergePlan(cwd).then(setPlan)}
            className="lbl mt-2 rounded border border-[var(--line)] px-1.5 py-0.5 hover:!text-[var(--fg)]"
          >
            check again
          </button>
        </div>
      )}

      {tab === 'changes' && !!counts.staged && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
          <input
            ref={(el) => (msgRef.current = el)}
            className="field min-w-0 flex-1"
            placeholder={`commit ${counts.staged} staged file(s) in ${target === 'repo' ? 'the main checkout' : 'this worktree'}…`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && message.trim()) void doCommit()
            }}
          />
          <button
            onClick={() => void doCommit()}
            disabled={committing || !message.trim()}
            className="chip chip-running shrink-0 hover:brightness-110 disabled:opacity-40"
          >
            {committing ? 'committing…' : 'commit'}
          </button>
        </div>
      )}

      {branchName !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
          <span className="lbl shrink-0">branch name</span>
          <input
            autoFocus
            className="field min-w-0 flex-1"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void pushBranch()
              if (e.key === 'Escape') setBranchName(null)
            }}
          />
          <button
            onClick={() => void pushBranch()}
            disabled={pushingBranch || !branchName.trim()}
            className="chip chip-running shrink-0 hover:brightness-110 disabled:opacity-40"
          >
            {pushingBranch ? 'pushing…' : 'push'}
          </button>
          <button onClick={() => setBranchName(null)} className="lbl shrink-0 hover:!text-[var(--fg)]">
            cancel
          </button>
        </div>
      )}

      {pushMsg && (
        <div
          className={`shrink-0 border-b border-[var(--line)] px-3 py-1.5 text-[10.5px] ${
            pushMsg.ok ? 'text-[var(--accent)]' : 'text-[var(--danger)]'
          }`}
        >
          {linkify(pushMsg.text)}
        </div>
      )}

      {!!status?.unpushedCommits.length && (
        <div className="max-h-[30%] shrink-0 overflow-auto border-b border-[var(--line)]">
          <div className="lbl sticky top-0 z-10 bg-[var(--panel)] px-3 py-1.5">
            {status.upstream ? `not on ${status.upstream}` : 'not pushed anywhere yet'}{' '}
            <span className="text-[var(--dim)]">{status.unpushedCommits.length}</span>
          </div>
          {status.unpushedCommits.map((c) => (
            <Commit key={c.sha} c={c} />
          ))}
        </div>
      )}

      {isWorktree && target === 'worktree' && plan && <LandedBand plan={plan} counts={counts} />}
      {tab === 'changes' && isWorktree && target === 'worktree' && <SeedBand repoPath={repoPath} cwd={cwd} />}

      <div className="min-h-0 flex-1">
        {tab === 'ship' ? (
          <ShipPane
            cwd={cwd}
            onDone={() => void refresh()}
            wt={wt}
            host={host}
            plan={plan}
            worktree={isWorktree}
            busy={merging ? 'merging…' : pushing ? 'pushing…' : committing ? 'committing…' : null}
            onStage={() => {
              setTarget('worktree')
              void window.api.git.stage(cwd, (wt?.unstaged ?? []).map((f) => f.path)).then(refresh)
            }}
            onCommit={() => {
              setTab('changes')
              setTarget('worktree')
              // the message is the one thing only a person can supply, so the button lands the cursor in it
              if (!message.trim()) msgRef.current?.focus()
              else void doCommit()
            }}
            onMerge={() => void merge()}
            onUpdate={() => void update()}
          />
        ) : tab === 'history' ? (
          <History cwd={view} />
        ) : tab === 'branches' ? (
          <Branches cwd={view} />
        ) : !status ? (
          <div className="flex h-full items-center justify-center text-[11px] text-[var(--dim)]">reading git status…</div>
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-[11px] text-[var(--dim)]">
            <span className="text-[var(--muted)]">nothing changed yet</span>
            <span>
              working tree clean on <span className="mono">{status.branch}</span>
              {status.base ? <> and level with <span className="mono">{status.base}</span></> : null}
            </span>
            <span className="mono text-[9.5px]">{status.root}</span>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="max-h-[45%] shrink-0 overflow-auto border-b border-[var(--line)]">
              <Group title="staged changes" files={status.staged} sel={sel} onPick={setSel} onStage={stage} />
              <Group title="changes" files={status.unstaged} sel={sel} onPick={setSel} onStage={stage} />
              <Group
                title={
                  // The list alone cannot say whether these files ever left the worktree, which is
                  // the question a reader actually has: committed here, merged into main, pushed.
                  plan?.commits
                    ? `committed · not in ${plan.into} yet`
                    : plan
                      ? `committed · in ${plan.into}${plan.baseUnpushed ? ` · ${plan.into} not pushed yet` : ' · pushed'}`
                      : `committed on ${status.branch}`
                }
                files={status.committed}
                sel={sel}
                onPick={setSel}
                base={status.base ?? undefined}
              />
            </div>
            <div className="min-h-0 flex-1">
              {sel ? (
                <DiffView diff={diff} path={sel.path} />
              ) : (
                <div className="flex h-full items-center justify-center text-[11px] text-[var(--dim)]">
                  pick a file to see its diff
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// git hands back the pull-request URL on a first push; make it clickable rather than something to copy
function linkify(text: string): React.ReactNode {
  const parts = text.split(/(https?:\/\/\S+)/g)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <button
        key={i}
        onClick={() => void window.api.shell.openExternal(part)}
        className="underline decoration-current/40 hover:decoration-current"
      >
        {part}
      </button>
    ) : (
      <span key={i}>{part}</span>
    )
  )
}

function Commit({ c }: { c: GitCommit }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-3 py-1" title={`${c.sha} · ${c.author} · ${c.at}`}>
      <span className="mono shrink-0 text-[10px] text-[var(--accent)]">{c.sha}</span>
      <span className="min-w-0 flex-1 truncate text-[11px]">{c.subject}</span>
      <span className="mono shrink-0 text-[9px] text-[var(--dim)]">{age(c.at)}</span>
    </div>
  )
}

function Group({
  title,
  files,
  sel,
  onPick,
  base,
  onStage
}: {
  title: string
  files: GitFile[]
  sel: Selection | null
  onPick: (s: Selection) => void
  base?: string
  onStage?: (paths: string[], on: boolean) => void
}): JSX.Element | null {
  if (!files.length) return null
  return (
    <div>
      <div className="lbl sticky top-0 z-10 bg-[var(--panel)] px-3 py-1.5">
        {title} <span className="text-[var(--dim)]">{files.length}</span>
      </div>
      {files.map((f) => {
        const on = sel?.path === f.path && sel.staged === f.staged && !!sel.base === !!base
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
        const name = f.path.slice(f.path.lastIndexOf('/') + 1)
        return (
          <button
            key={`${title}-${f.path}`}
            onClick={() => onPick({ path: f.path, staged: f.staged, untracked: f.letter === '?', base })}
            title={`${f.status} · ${f.path}`}
            className={`flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-[var(--raised)] ${
              on ? 'bg-[var(--raised)] shadow-[inset_2px_0_0_var(--accent)]' : ''
            }`}
          >
            <span className="mono min-w-0 flex-1 truncate text-[11px]">
              {name}
              {dir && <span className="ml-2 text-[9.5px] text-[var(--dim)]">{dir}</span>}
            </span>
            <span className={`mono shrink-0 text-[10px] ${letterColor[f.letter] ?? 'text-[var(--muted)]'}`}>{f.letter}</span>
            {onStage && !base && (
              <span
                role="button"
                title={f.staged ? 'unstage this file' : 'stage this file'}
                onClick={(e) => {
                  e.stopPropagation()
                  onStage([f.path], !f.staged)
                }}
                className="mono shrink-0 rounded px-1 text-[11px] text-[var(--dim)] hover:bg-[var(--panel)] hover:text-[var(--fg)]"
              >
                {f.staged ? '−' : '+'}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Where this worktree's work has actually got to.
 *
 * Staging and committing happen inside the worktree, and merging happens in the checkout next to it,
 * so "I staged some files" and "my work is in main" look identical from here. This says which of the
 * three it is, in one line: still uncommitted, committed but not merged, or in main — and if it is
 * in main, whether main itself has been pushed anywhere.
 */
function LandedBand({
  plan,
  counts
}: {
  plan: MergePlan
  counts: { staged: number; unstaged: number; committed: number }
}): JSX.Element {
  const loose = counts.staged + counts.unstaged
  // Two independent facts, and conflating them is what made this line lie: whether the commits have
  // reached the base branch, and whether there is work here that is not committed at all. Staged
  // files are not "nothing committed yet" when two commits already landed in main.
  const pending = plan.commits > 0
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--line)] px-3 py-1.5">
      <span className="mono shrink-0 text-[10px] text-[var(--dim)]">
        {plan.branch} → {plan.into || '?'}
      </span>
      <span className="mono shrink-0 text-[11px]" style={{ color: pending ? 'var(--muted)' : 'var(--accent)' }}>
        {pending ? `${plan.commits} commit(s) not in ${plan.into}` : `✓ nothing left to merge into ${plan.into}`}
      </span>
      {!!loose && (
        <span className="mono shrink-0 text-[10px] text-[var(--warn)]">
          · {loose} file(s) not committed yet
        </span>
      )}
      {!pending && (
        <span
          className="mono ml-auto shrink-0 text-[10px]"
          style={{ color: plan.baseUnpushed ? 'var(--warn)' : 'var(--dim)' }}
        >
          {plan.baseUnpushed
            ? `${plan.into} is ${plan.baseUnpushed} ahead of origin — still to push`
            : `${plan.into} matches origin`}
        </span>
      )}
    </div>
  )
}
