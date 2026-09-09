# Agent Fleet

A macOS desktop app for running many Claude Code agents at once and seeing what each one is doing.

Claude Code is a terminal tool. With five or six sessions open you lose track of which one is working,
which one is waiting on you, and what any of them changed. Agent Fleet puts all of them on one screen:
a live fleet view, a terminal or chat per agent, the git diff for that agent's worktree, and a browser
the agent can drive.

It does not replace Claude Code. It drives the `claude` CLI you already have, using your existing
login, and reads the same files Claude Code writes.

## What it does

**Sees every session, not just its own.** It tails `~/.claude/projects/*/*.jsonl`, so agents you
started in a terminal show up beside agents the app launched, with their repo, branch, model, last
slash command, token counts and current tool call.

**Shows which agents are alive.** State comes from the transcript and from hooks the app installs:
running, waiting for you, idle, stale or ended. A running card animates, so a glance is enough.

**Draws the subagent tree.** When an agent spawns subagents they appear under it, nested to whatever
depth they reach, and you can open any of them to read its own log.

**Gives each agent a worktree.** Optional per agent. The agent works in
`<repo>/.claude/worktrees/<name>` on its own branch, so two agents on the same repo never collide.

**Chat or terminal, your choice.** Either the real Claude Code TUI in an embedded terminal, or a chat
built on top of the same pty: markdown rendering, a tool call timeline, an interrupt button, and
buttons for the slash commands you type most.

**Ships the work.** One tab takes a finished worktree all the way to `origin/main`, with a checklist
before and a live timeline while it runs. See below.

**Browses.** Each agent can have its own embedded Chromium view with its own session, driven over an
MCP server the app runs. You watch a real cursor move and click.

**Shows real usage.** Context, 5 hour and 7 day rate limits, read from the live status line payload
rather than the cache in `~/.claude.json`, which is often hours old.

## Requirements

- macOS on Apple Silicon
- Claude Code installed and logged in
- `git`, `jq` and `tmux`
- Node 20+ and pnpm 10+, to build from source

## Running it

```bash
pnpm install
pnpm dev
pnpm test     # the session state machine, node --test
```

`pnpm install` downloads the Electron binary and rebuilds `node-pty` against Electron's ABI, which is
not the one your system node uses. Both are build steps pnpm 10 blocks unless a project asks for them,
so `pnpm.onlyBuiltDependencies` in `package.json` names the three that are needed. If pnpm still
reports ignored build scripts, you are on a version that reads the list from `pnpm-workspace.yaml`
instead; run `pnpm approve-builds` and pick `electron`, `esbuild` and `node-pty`.

If `pnpm dev` says `Error: Electron uninstall`, the Electron binary unpacked only partly. Seen on
Node 26: the `extract-zip` step inside Electron's own postinstall creates `Electron.app/Contents/MacOS`
and `Resources`, never writes `path.txt`, and exits 0 with nothing on stderr, so both `pnpm install`
and `pnpm rebuild electron` report success. The downloaded zip itself is fine, and the system `unzip`
handles it:

```bash
E=node_modules/electron
unzip -oq ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip -d $E/dist
printf 'Electron.app/Contents/MacOS/Electron' > $E/path.txt
ls $E/dist/Electron.app/Contents   # Frameworks, Info.plist, MacOS, PkgInfo, Resources
```

Whether this is specific to Node 26 has not been checked against an older Node.

First run, press **install hooks**. That adds one entry per hook event to `~/.claude/settings.json`
and arranges for the status line payload to be saved. Both are backed up first, and both can be
removed from the same button.

To build something you can send to someone else:

```bash
pnpm dist        # release/Agent Fleet-0.0.1-arm64.dmg
pnpm dist:dir    # just the .app, for a quick local test
```

The build is unsigned, so on another Mac it needs `xattr -cr "/Applications/Agent Fleet.app"` once
before it will open.

## The ship flow

The part that saves the most time. An agent finishes work in a worktree, and getting that to GitHub
by hand is five commands across two checkouts, with silent ways to go wrong.

Open the agent, git tab, **ship**. It fetches first, then shows what will happen:

```
1  ✓ check the repository        1 uncommitted file(s) ready for main
2  ✓ commit the agent's work     [feat cd60920] add e
3  ✓ set aside 1 local file(s)   stashed, restored at the end
4  ● update main from origin     running
5  │ merge into main
6  │ push main to origin
```

Press ship, confirm, and the list fills in as it goes, with a duration per step. It commits loose work
under a message you type, fast-forwards the base branch if it moved, stashes anything uncommitted in
your main checkout and puts it back afterwards, merges, and pushes. Conflicts block before anything is
touched and name the files. A failure stops the run, aborts a half merge and restores the stash.

Afterwards you get the pushed sha, a link to the commit on GitHub, and a line naming what builds it
(a `heroku` remote by name, or a committed Procfile meaning an app wired to GitHub is building now).

Not ready for main? Use **push as branch** and then the **pull request** button, which opens the
GitHub compare page. That needs no `gh` CLI.

## Worktree seeding

A worktree contains only what git tracks, so everything ignored on purpose is missing from it. The
first thing an agent usually hits is a missing `.env`.

At launch the app copies the ignored config across: `.env` and `.env.*`, `.npmrc`, `.yarnrc`,
`.tool-versions`, `*.pem`, `*.key`, `credentials.json` and similar. Copies, not links, so an agent
cannot damage the originals. Build output, `.claude` and editor litter are never carried.

Dependency directories (`node_modules`, `vendor`, `.venv`, `Pods`) are offered as a symlink instead,
from the environment band at the top of the git tab, because copying them per agent costs minutes and
gigabytes. Linking a directory also writes it into the worktree's `info/exclude`, since a
`node_modules/` gitignore pattern does not match a symlink and the link would otherwise show up as
untracked.

## Layout

```
src/main/          Electron main process
  sessions/        JSONL tailer, liveness, topic lookup
  agents/          launch, resume, tmux for detached agents
  git/             exec (primitives), read (queries), index (writes), ship, seed
  browser/         one Chromium view per agent, MCP server, CDP tools
  hooks/           hook installer and the local receiver
  usage/           rate limits and context, live and cached
src/renderer/      React UI
  fleet/           fleet view, cards, usage strip, themes
  workspace/       terminal, chat, right panel
  git/             changes, history, branches, ship, environment band
src/preload/       the IPC surface
resources/         MCP shim, hook scripts, icon
ongoing-implementations/   the working notes for this project
```

## Things worth knowing

**Two instances fight over ports.** The hook receiver uses 47391 and the browser control server
47392. Running a second copy alongside `pnpm dev` needs `AGENT_FLEET_HOOK_PORT` and
`AGENT_FLEET_BROWSER_PORT` set, or the browser silently stops working.

**`pnpm dev` does not restart the main process.** Anything under `src/main` or `src/preload` needs a
full restart, and a stale preload shows up as "not a function" in the renderer.

**The embedded browser paints above the DOM.** It is a native view, so menus and dialogs park it out
of the way while they are open. Anything drawn over that area has to do the same.

**Themes are only CSS variables.** Eight of them, four named after AI vendors. Nothing is restyled per
theme, so a new one means a new variable set, and the terminal listens for a theme event because it is
not styled by CSS.

**Agents can be detached.** A detached agent runs inside tmux, so closing the app detaches instead of
killing it, and reopening reattaches.

**The local servers want a secret.** The browser control server on 47392 only answers requests
carrying the per-run secret it hands to the MCP shims it spawns, and refuses anything that arrives
with an `Origin` or `Referer` header, since only a web page sets those.

**Nothing commits or pushes on its own.** Every git action is behind a button you press, and the
destructive ones ask for a second press.
