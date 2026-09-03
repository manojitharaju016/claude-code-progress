# Work Progress — a private live dashboard of your Claude Code work

Shows every project you run Claude Code in, its stages (sessions) and sub-tasks
(to-do lists), with hierarchical progress bars, a "working now" highlight, and
editable titles. Reads your local Claude Code logs, publishes privately, and
(later) merges every machine you use into one view.

**Everything is free** (a free private GitHub repo + a free Cloudflare Worker).

This is a template: fork or clone it, point it at your own GitHub account and
your own Cloudflare account, and it's entirely yours — nothing here talks to
anyone else's infrastructure.

**Supported OS:** macOS and Linux (the scripts use `flock`/`setsid`/`nohup`
fallbacks written for those two). Not tested on Windows/WSL.

## Prerequisites

- A GitHub account with the ability to create a private repo.
- A Cloudflare account (the free tier is enough).
- `git`, `bash`, and `python3` on your PATH.

## How it fits together

```
Claude Code turn ends
  -> Stop hook  (hook-launch.sh, returns instantly)
       -> run.sh (detached): reader.py compiles progress.json
            -> force-pushes it to a `data-<machine>` branch (one rolling commit)
Browser (any device)
  -> Cloudflare Worker  (password gate on EVERYTHING)
       -> GET /api/data : reads every data-<machine> branch + overlay.json
                          (overlay branch), merges, returns to the page
       -> POST /api/save: writes your rename/hide to overlay.json only
```

- `agent/reader.py` — reads `~/.claude/projects/*` + `~/.claude/sessions/*`,
  extracts the latest real to-do list per session (structural
  `"name":"TodoWrite"` match), never publishes prompts, scrubs secrets, writes
  `data/progress.json`.
- `src/worker.js` + `wrangler.toml` — the Cloudflare Worker: password gate,
  `/api/data`, `/api/save`.
- `public/` — the dashboard (`index.html`, `styles.css`, `app.js`, vanilla JS).
- `agent/run.sh` / `agent/hook-launch.sh` / `agent/install-hook.sh` /
  `agent/setup.sh` / `agent/install-machine.sh` — the local agent. These are
  committed here under `agent/`; Setup step 0 below copies them to
  `~/.claude/cc-progress/` on each machine you run them on (that local copy,
  and everything it writes — your token, your machine label, logs, cache — is
  gitignored and never committed).
- `agent/server.py` — an alternative, fully local mode with no GitHub/Cloudflare
  at all (see "Local-only mode" below).

Three branches on your repo: **main** = site (Cloudflare builds this, rarely),
**data-\<machine\>** = one branch per machine's `progress.json` (reader, force-pushed
rolling commit → no history bloat), **overlay** = `overlay.json` (Worker, your
edits). Neither data nor overlay branches ever trigger a Cloudflare build.

## Privacy notes — read this before you publish anything

- The site is gated by `SITE_PASSWORD` on every path (page + API). Anyone with
  the password can open it — keep it private. (A per-email login was the
  alternative but needs a card on file with Cloudflare.)
- Your typed prompts are **never** published — only titles, to-do text, the
  project's absolute working-directory path, and the current git branch name,
  with secret-pattern scrubbing on top of all of it (belt and braces, not a
  guarantee).
- That working-directory path is a real absolute path on your machine (it
  usually embeds your OS username and can reveal a client/employer/project
  name you weren't consciously choosing to publish) — pushed to your GitHub
  repo's data branch and served through your Cloudflare Worker. If that's a
  problem for a given machine, don't run the agent there, or use "Local-only
  mode" below instead.
- Two third parties hold this data: **GitHub** (the private repo, even though
  it's private) and **Cloudflare** (serves it, behind the password gate). Both
  are the accounts YOU control when you follow the setup below — nothing is
  sent to the original author or anyone else.
- The fine-grained token lives only in `~/.claude/cc-progress/.token` (chmod
  600) and in Cloudflare's encrypted secret — never in the repo, never in the
  browser.

## Setup

### Step 0: get the code onto this machine

```bash
mkdir -p ~/.claude/cc-progress
cp agent/*.sh agent/*.py ~/.claude/cc-progress/
git clone <URL-of-your-fork-of-this-repo> ~/.claude/cc-progress/repo
```

(`agent/setup.sh`, run next, pushes `~/.claude/cc-progress/repo`'s contents —
`public/`, `src/`, `wrangler.toml` — to your new repo's `main` branch.)

### 1. Create the private repo
Make an **empty private** repo on GitHub named whatever you like (e.g.
`work-progress`), under **your own** GitHub account. No README/license — leave
it empty.

### 2. Create a fine-grained token (single repo)
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
- Resource owner: your account · Repository access: **Only select repositories** →
  the repo you just made
- Permissions → Repository → **Contents: Read and write** (Metadata read is added
  automatically) · set an expiry you'll remember to renew.

Save the token string to `~/.claude/cc-progress/.token` (one line), then it's used
by both the reader (to push) and Cloudflare (to read/write). It is **not** your
broad token — it can only touch this one repo.

### 3. Push everything
```bash
CC_PROGRESS_OWNER=<your-github-username> CC_PROGRESS_REPO=<your-repo-name> \
  bash ~/.claude/cc-progress/setup.sh
```
Creates `main`, `data`, `overlay` and the reader's push clone. Test the reader:
```bash
bash ~/.claude/cc-progress/run.sh && tail ~/.claude/cc-progress/run.log
```

### 4. Cloudflare (the website)
Cloudflare dashboard → **Workers & Pages** → Create → **Workers** → **Connect to
Git** → pick your repo, branch `main`. It reads `wrangler.toml` (no build
command needed).

**Before deploying**, edit `wrangler.toml` and set `GH_OWNER` / `GH_REPO` to
your own GitHub username and repo name (steps 1–2 above) — the placeholders
`YOUR_GITHUB_USERNAME` / `YOUR_REPO_NAME` won't work as-is. Commit that change
to `main` (or edit it directly in the Cloudflare dashboard's Git integration).

Then Worker → Settings → **Variables and Secrets** add two **Secrets**:
- `GH_TOKEN` = the fine-grained token from step 2
- `SITE_PASSWORD` = a password you choose (this is what opens the site)

Deploy. Open the Worker URL (e.g. `https://work-progress.<you>.workers.dev`,
or whatever `name` you set in `wrangler.toml`); the browser asks for a
password — leave username blank / anything, password = `SITE_PASSWORD`.

### 5. Go live (start auto-updating)
```bash
CC_PROGRESS_OWNER=<your-github-username> CC_PROGRESS_REPO=<your-repo-name> \
  bash ~/.claude/cc-progress/install-machine.sh
bash ~/.claude/cc-progress/install-hook.sh
```
Adds a second Stop hook (keeps your existing hooks, if any). From now on every
Claude Code turn on this machine refreshes the dashboard within ~10–25 s.

### Local preview, without touching GitHub or Cloudflare
Iterate on `public/` directly:
```bash
python3 agent/reader.py --out public/data.json --no-cache
python3 -m http.server -d public 8000
```
`public/app.js` falls back to `./data.json` whenever `/api/data` isn't
reachable, so this works with no server-side setup at all (it just won't
auto-refresh or save edits).

### Local-only mode (no GitHub, no Cloudflare)
If you don't want anything pushed to GitHub at all, run `agent/server.py`
instead of steps 1–5 above — it serves the same dashboard straight off this
machine, with its own password:
```bash
python3 agent/server.py                       # 127.0.0.1:8787
python3 agent/server.py --host 0.0.0.0         # reachable on your LAN
```
The password is read from `$CC_PROGRESS_PASSWORD`, or auto-generated on first
run and saved to `~/.claude/cc-progress/.site_password`. From another device,
SSH-tunnel in: `ssh -L 8787:localhost:8787 <you>@<this-host>`, then open
`http://localhost:8787/`.

## Troubleshooting

- **Dashboard shows a "github-unavailable" banner / API returns 503** — your
  fine-grained token has likely expired (you set an expiry in step 2) or is
  rate-limited. Generate a new token, update it in `.token` and in the
  Cloudflare Worker's `GH_TOKEN` secret.
- **Password prompt keeps rejecting you (permanent 401)** — `SITE_PASSWORD`
  isn't set in the Worker's secrets (Worker → Settings → Variables and
  Secrets), or was set on a different Worker than the one you deployed.
- **Dashboard stopped updating** — check `~/.claude/cc-progress/run.log` on
  the machine in question; confirm the Stop hook is installed
  (`bash ~/.claude/cc-progress/install-hook.sh` is idempotent, safe to
  re-run); confirm the token hasn't expired (see above).
- **A machine reports itself as "machine" instead of its real name** — its
  `.machine` file is missing and `hostname -s` returned nothing useful; re-run
  `install-machine.sh` with an explicit name.

## Update / uninstall

- **Update the code**: pull the latest commit into
  `~/.claude/cc-progress/repo` and re-run `setup.sh`'s main-branch push step,
  or just re-run `setup.sh` (idempotent).
- **Remove a machine**: delete its `data-<machine>` branch on GitHub; the
  Worker will stop including it.
- **Uninstall entirely**: remove the Stop hook entry from
  `~/.claude/settings.json` (a `.bak` was saved when you installed it), delete
  the Cloudflare Worker, delete the GitHub repo, and `rm -rf
  ~/.claude/cc-progress` on every machine.

## Later: add another machine (laptop, desktop, server)
Copy `~/.claude/cc-progress/` (reader + scripts) to the machine, drop in a
token, run `install-machine.sh` for its own `data-<machine>/progress.json`,
install the hook. Each machine pushes independently over HTTPS; the Worker
merges them.

## License
MIT — see [LICENSE](LICENSE).
