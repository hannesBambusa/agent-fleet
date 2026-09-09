# Agent Fleet

Electron + React + TypeScript desktop app (macOS) that observes every Claude Code session on the
machine, launches new ones in git worktrees, and gives each a terminal or chat, a git pane and an
embedded browser. It drives the `claude` CLI and reads the files Claude Code writes. See README.md
for what it does; this file is how to work on it.

## Commands

```bash
pnpm dev         # electron-vite dev
pnpm typecheck   # both tsconfigs, run before calling anything done
pnpm build       # out/
pnpm dist        # release/*.dmg, mac arm64, unsigned
```

**`pnpm dev` does not restart the main process.** Any change under `src/main` or `src/preload` needs
a full restart. A stale preload surfaces as `window.api.x is not a function` in the renderer, and a
stale main as `No handler registered for '...'`. Both mean restart, not a bug in the new code.

## Where things live

| Path | What |
|---|---|
| `src/main/sessions/` | JSONL tailer, process liveness, session state |
| `src/main/agents/` | launch, resume, tmux for detached agents, worktree naming |
| `src/main/git/` | status, diff, merge, ship, worktree seeding |
| `src/main/browser/` | one Chromium view per agent, MCP server, CDP tools |
| `src/main/hooks/` | hook installer, local receiver on 47391 |
| `src/main/usage/` | rate limits and context, live payload and cache |
| `src/renderer/src/` | React UI, grouped by area |
| `src/shared/types.ts` | every type that crosses the IPC boundary |
| `ongoing-implementations/agent-fleet.md` | the working notes: what is built, gotchas, decisions |

## Adding an IPC call

Four edits, in this order, or it fails at runtime rather than at typecheck:

1. the type in `src/shared/types.ts`
2. the implementation in `src/main/<area>/`
3. `ipcMain.handle('area:verb', ...)` in `src/main/index.ts`
4. the wrapper in `src/preload/index.ts`

Then restart the app.

## Conventions

- Comments explain **why**, never what. A comment that restates the line is noise; one that records
  the trap it avoids is the point.
- Colors come from CSS variables (`--ink --panel --raised --line --fg --muted --dim --accent --warn
  --danger` and the derived `--accent-soft --sweep --sub`). Never a literal hex in a component.
  Themes are only variable sets, so a hardcoded color breaks half of them.
- Shared classes: `lbl` for uppercase mono labels, `chip` plus `chip-running` / `chip-waiting` /
  `chip-idle` for buttons, `mono` for values.
- Destructive or outward-facing buttons confirm on a second press. Nothing reaches a remote without
  the user pressing it.
- Prose in the UI, in docs and in commit messages: plain words, no em dashes, no filler.

## Gotchas that have already cost time

- **`git()` in `src/main/git/index.ts` only rejects when stderr is non-empty**, so a command that
  fails silently reads as success. Existence checks must ask for a value (`rev-parse --verify
  --quiet`) and judge the output. `show-ref --quiet` is exactly the broken case.
- **`git rev-parse --abbrev-ref origin/HEAD` prints the argument back on stdout while failing** when
  no default is set, which yields the literal `HEAD` as a branch name.
- **`git status --porcelain` lines must not be trimmed** before the path is cut out. The status
  letters are columns; trimming makes `slice(3)` eat the filename.
- **A nested worktree looks like an untracked directory to the parent checkout.** Never `git stash -u`
  there; stash explicit paths.
- **A `node_modules/` gitignore pattern does not match a symlink** of that name, so a linked
  dependency directory has to go in the worktree's `info/exclude`.
- **`SessionStart` is not work.** It fires on startup, resume, `/clear` and compaction. Mapping it to
  a running state paints idle agents green.
- **Ports 47391 (hooks) and 47392 (browser control) are per machine.** A second instance needs
  `AGENT_FLEET_HOOK_PORT` and `AGENT_FLEET_BROWSER_PORT`, or the browser silently stops working.
- **A `WebContentsView` has no compositor until it is added to a window**, and it always paints above
  the DOM. Attach on create and park it at 1x1; park it again while menus or dialogs are open.
- **Rate limits and context are only live in the status line payload.** `cachedUsageUtilization` in
  `~/.claude.json` is refreshed rarely and is routinely hours stale, whatever the file mtime says.
- **`pnpm pack` is a built-in pnpm command** and shadows a script of that name. The script is `dist`.

## Verifying changes

There is no test framework here. Main process modules are plain functions, so the way to check one is
to bundle it and run it against a real or scratch repository:

```bash
node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild src/main/git/index.ts \
  --bundle --platform=node --format=cjs --outfile=.t.cjs --log-level=error
node -e "require('./.t.cjs').shipPlan('/path/to/worktree').then(console.log)"
rm -f .t.cjs
```

Build a scratch repo in the scratchpad directory for anything that writes. Never test a destructive
path against a real repository. Always finish with `pnpm typecheck` and `pnpm build`.

## Git

**Never run `git commit`, `git push`, `git merge`, `git rebase`, `git tag`, `gh pr create` or
anything else that writes history or reaches a remote.** Staging when asked is fine, reading state is
always fine. Stop at the diff, say what changed and which files belong to the change, and hand it
over. This holds even when the work is finished and the tests pass.

The app itself does merge and push, from buttons the user presses. That is the product, not a licence
for the agent working on it.

## Keeping the notes current

`ongoing-implementations/agent-fleet.md` is the handoff. When a unit of work lands, move it from
`## Remaining` to `## Built` with the path that proves it, record a new trap in `## Gotchas` while it
is fresh, and bump `Updated`. Supersede stale lines instead of appending corrections under them.
