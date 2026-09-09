import type { GitBranch, GitCommit, GitCommitDetail, GitFile, GitStatus } from '../../shared/types'
import { baseOf, git, upstreamState } from './exec'

// Read-only queries: safe to call on a timer, and the git pane does exactly that.

function label(code: string): string {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflict'
    case '?':
      return 'untracked'
    default:
      return 'changed'
  }
}

export async function status(cwd: string): Promise<GitStatus> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const out = await git(cwd, ['status', '--porcelain', '-uall', '-z'])
  const staged: GitFile[] = []
  const unstaged: GitFile[] = []

  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    let path = entry.slice(3)
    // a rename is followed by its old path in the next NUL-separated field
    if (x === 'R' || x === 'C') i += 1
    if (x === '?' && y === '?') {
      unstaged.push({ path, status: 'untracked', letter: '?', staged: false, committed: false })
      continue
    }
    if (x !== ' ' && x !== '?') staged.push({ path, status: label(x), letter: x, staged: true, committed: false })
    if (y !== ' ' && y !== '?') unstaged.push({ path, status: label(y), letter: y, staged: false, committed: false })
  }

  // work the agent already committed on its own branch is still "its changes" to a reader
  const committed: GitFile[] = []
  let base: string | null = null
  let ahead = 0
  try {
    base = await baseOf(cwd, branch)
    if (base) {
      ahead = Number((await git(cwd, ['rev-list', '--count', `${base}..HEAD`])).trim()) || 0
      if (ahead > 0) {
        const names = await git(cwd, ['diff', '--name-status', `${base}...HEAD`])
        for (const line of names.split('\n')) {
          const [code, ...rest] = line.split('\t')
          const path = rest[rest.length - 1]
          if (!code || !path) continue
          const letter = code[0]
          committed.push({ path, status: label(letter), letter, staged: false, committed: true })
        }
      }
    }
  } catch {
    // no base branch to compare against; committed stays empty
  }

  const up = await upstreamState(cwd)
  // with no upstream yet, every commit this branch added on top of its base is unpublished
  const range = up.upstream ? '@{upstream}..HEAD' : base ? `${base}..HEAD` : 'HEAD'
  const unpushedCommits = up.upstream || base ? await commits(cwd, range) : []
  const unpushed = up.upstream ? up.ahead : unpushedCommits.length

  const sort = (a: GitFile, b: GitFile): number => a.path.localeCompare(b.path)
  return {
    root,
    branch,
    base,
    upstream: up.upstream,
    unpushed,
    unpushedCommits,
    behind: up.behind,
    ahead,
    staged: staged.sort(sort),
    unstaged: unstaged.sort(sort),
    committed: committed.sort(sort)
  }
}

export async function diff(
  cwd: string,
  path: string,
  staged: boolean,
  untracked: boolean,
  base?: string,
  sha?: string
): Promise<string> {
  if (sha) return git(cwd, ['show', '--no-color', '--format=', sha, '--', path])
  if (base) return git(cwd, ['diff', '--no-color', `${base}...HEAD`, '--', path])
  if (untracked) {
    // /dev/null against the file renders a new file as one big addition
    return git(cwd, ['diff', '--no-index', '--', '/dev/null', path]).catch(() => '')
  }
  const args = ['diff', '--no-color']
  if (staged) args.push('--cached')
  args.push('--', path)
  return git(cwd, args)
}

const SEP = '\x1f'

const FMT = ['%h', '%s', '%aI', '%an', '%D', '%p'].join(SEP)

function parse(out: string): GitCommit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, at, author, refs, parents] = line.split(SEP)
      return {
        sha,
        subject,
        at,
        author,
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        parents: parents ? parents.split(' ').filter(Boolean) : []
      }
    })
}

async function commits(cwd: string, range: string, max = 25): Promise<GitCommit[]> {
  const out = await git(cwd, ['log', `--max-count=${max}`, `--format=${FMT}`, range]).catch(() => '')
  return parse(out)
}

/**
 * History across every ref, in the order the graph is drawn.
 *
 * `--date-order` rather than the default: it keeps a branch's commits together instead of
 * interleaving them strictly by date, which is what makes the lanes readable. `--all` so a worktree's
 * branch and the remote's head both show up beside main, which is the whole point of looking.
 */
export function graph(cwd: string, max = 200): Promise<GitCommit[]> {
  return git(cwd, ['log', '--all', '--date-order', `--max-count=${max}`, `--format=${FMT}`])
    .then(parse)
    .catch(() => [])
}

export function log(cwd: string, max = 120): Promise<GitCommit[]> {
  return commits(cwd, 'HEAD', max)
}

export async function commitDetail(cwd: string, sha: string): Promise<GitCommitDetail> {
  const fmt = ['%H', '%h', '%s', '%b', '%aI', '%an', '%ae', '%D'].join(SEP)
  const head = await git(cwd, ['show', '--no-patch', `--format=${fmt}`, sha])
  const [full, short, subject, body, at, author, email, refs] = head.split(SEP)
  const names = await git(cwd, ['show', '--no-color', '--name-status', '--format=', sha])
  const files: GitFile[] = names
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split('\t')
      const path = rest[rest.length - 1]
      return { path, status: label(code[0]), letter: code[0], staged: false, committed: true }
    })
  const stat = await git(cwd, ['show', '--shortstat', '--format=', sha]).catch(() => '')
  return {
    sha: full.trim(),
    short,
    subject,
    body: (body ?? '').trim(),
    at,
    author,
    email,
    refs: refs ? refs.trim().split(', ').filter(Boolean) : [],
    files,
    stat: stat.trim()
  }
}

export async function branches(cwd: string): Promise<GitBranch[]> {
  const fmt = [
    '%(refname:short)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(HEAD)',
    '%(committerdate:iso-strict)',
    '%(contents:subject)'
  ].join(SEP)
  const out = await git(cwd, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, track, head, at, subject] = line.split(SEP)
      return {
        name,
        upstream: upstream || null,
        ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
        current: head.trim() === '*',
        at,
        subject
      }
    })
}
