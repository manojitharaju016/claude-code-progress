# Claude Code Progress

A private, live dashboard of everything Claude Code is working on — every
project, every session, every to-do list — across all of your machines.
Self-hosted for free on a Cloudflare Worker backed by a private GitHub
repository. No database, no server to run, and nothing is sent anywhere except
accounts you own.

## What it shows

- **Every project** Claude Code has run in, grouped by git repository (or
  top-level folder), with an overall progress bar.
- **Every session** inside a project, titled from Claude Code's own session
  title, with its to-do list and completion percentage.
- **Running now** — one card per live session, with elapsed time and the
  to-do item it is currently on.
- **Multiple machines** — each machine reports separately; the dashboard merges
  them and lets you switch between them.
- **Editable** — rename or hide any project, session or to-do. Edits are stored
  separately from the collected data and survive every refresh.
- Search, filters (live / in progress / done / hidden), light and dark themes,
  auto-refresh every 20 seconds.

## How it works

```
Claude Code turn ends
  -> Stop hook  (agent/hook-launch.sh, returns instantly)
       -> agent/run.sh (detached): agent/reader.py compiles progress.json
            -> force-pushes it to the `data-<machine>` branch (one rolling commit)

Browser (any device)
  -> Cloudflare Worker  (password gate on every request)
       -> GET  /api/data : reads every data-<machine> branch + overlay.json,
                           merges them, returns JSON to the page
       -> POST /api/save : writes a rename/hide to overlay.json only
```

The private GitHub repository is the only storage. It holds three kinds of
branch:

| Branch | Written by | Contents |
|---|---|---|
| `main` | you | the site: `public/`, `src/`, `wrangler.toml` — Cloudflare deploys from here |
| `data-<machine>` | the reader on that machine | `data/progress.json`, one force-pushed rolling commit, so history never grows |
| `overlay` | the Worker | `data/overlay.json` — your renames and hides |

Pushes to the data and overlay branches never trigger a Cloudflare build.

### Repository layout

| Path | Purpose |
|---|---|
| `agent/reader.py` | Reads `~/.claude/projects/*` and `~/.claude/sessions/*`, extracts the latest to-do list and title per session, detects which sessions are live, scrubs secrets, writes `progress.json`. Standard library only. |
| `agent/run.sh` | Per-turn worker: runs the reader and pushes only when something changed (plus a periodic heartbeat). |
| `agent/hook-launch.sh` | The Claude Code Stop hook. Launches `run.sh` detached so a turn is never blocked. |
| `agent/setup.sh` | One-time setup on the first machine: pushes the site to `main`, creates that machine's `data-<machine>` branch and the `overlay` branch. |
| `agent/install-machine.sh` | Adds a further machine: creates its `data-<machine>` branch and installs the hook. |
| `agent/install-hook.sh` | Adds the Stop hook to `~/.claude/settings.json` (idempotent; existing hooks are kept). |
| `agent/server.py` | Optional fully local mode: serves the same dashboard from one machine with no GitHub or Cloudflare involved. |
| `src/worker.js` | The Cloudflare Worker: password gate, `/api/data`, `/api/save`. |
| `public/` | The dashboard: `index.html`, `styles.css`, `app.js` — vanilla JS, no build step. |
| `wrangler.toml` | Worker configuration. |

The `agent/` scripts run from `~/.claude/cc-progress/` on each machine (setup
copies them there). Everything they write locally — the token, the machine
label, logs, cache — stays in that folder and is gitignored.

## Requirements

- macOS or Linux. The scripts rely on `flock`/`setsid` or their
  `mkdir`/`nohup` fallbacks; Windows and WSL are untested.
- `git`, `bash` and `python3` on the PATH.
- A GitHub account that can create a private repository.
- A Cloudflare account (the free tier is sufficient).

## Setup

### 0. Get the code onto the first machine

```bash
mkdir -p ~/.claude/cc-progress
git clone https://github.com/manojitharaju016/claude-code-progress.git ~/.claude/cc-progress/repo
cp ~/.claude/cc-progress/repo/agent/*.sh ~/.claude/cc-progress/repo/agent/*.py ~/.claude/cc-progress/
```

### 1. Create an empty private repository

On GitHub, create a new **private** repository under your own account, with
any name (`work-progress` is used in the examples below). Leave it completely
empty: no README, no license.

### 2. Create a fine-grained token for that one repository

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new
token:

- Resource owner: your account
- Repository access: **Only select repositories** → the repository from step 1
- Permissions → Repository → **Contents: Read and write** (Metadata: read is
  added automatically)
- Expiration: choose one and note the date — the dashboard stops updating when
  it lapses (see Troubleshooting)

Save the token as a single line in `~/.claude/cc-progress/.token`. The reader
uses it to push and the Worker uses it to read and write. Because it is scoped
to one repository, it cannot touch anything else in your account.

### 3. Point the Worker configuration at your repository

Edit `~/.claude/cc-progress/repo/wrangler.toml` and set:

```toml
GH_OWNER = "your-github-username"
GH_REPO  = "work-progress"          # the repository from step 1
```

Optionally change `name`; it becomes the Worker's `*.workers.dev` subdomain.

### 4. Push the site and create the branches

```bash
CC_PROGRESS_OWNER=your-github-username CC_PROGRESS_REPO=work-progress \
  bash ~/.claude/cc-progress/setup.sh
```

This verifies the token, pushes `main`, creates this machine's
`data-<machine>` branch with a first `progress.json`, and creates the empty
`overlay` branch. The machine label defaults to the short hostname; override
it with `CC_PROGRESS_MACHINE=laptop`.

Confirm the reader works end to end:

```bash
bash ~/.claude/cc-progress/run.sh && tail ~/.claude/cc-progress/run.log
```

### 5. Deploy the Worker

Cloudflare dashboard → Workers & Pages → Create → Workers → **Connect to Git**
→ select the repository from step 1, branch `main`. Cloudflare reads
`wrangler.toml`; no build command is needed.

Then Worker → Settings → Variables and Secrets → add two **secrets**:

| Secret | Value |
|---|---|
| `GH_TOKEN` | the fine-grained token from step 2 |
| `SITE_PASSWORD` | the password that opens the site |

Deploy, then open the Worker URL
(`https://<name>.<your-subdomain>.workers.dev`). The browser asks for
credentials: leave the username empty and enter `SITE_PASSWORD`.

### 6. Go live

```bash
bash ~/.claude/cc-progress/install-hook.sh
```

This adds a Stop hook to `~/.claude/settings.json` (existing hooks are kept and
a timestamped backup is written first). From now on, every Claude Code turn on
this machine refreshes the dashboard within about 10–25 seconds.

### Adding another machine

On the new machine:

```bash
mkdir -p ~/.claude/cc-progress
# copy agent/*.sh, agent/*.py and .token from the first machine into ~/.claude/cc-progress/
CC_PROGRESS_OWNER=your-github-username CC_PROGRESS_REPO=work-progress \
  bash ~/.claude/cc-progress/install-machine.sh laptop     # the label is optional
```

This creates the machine's own `data-<machine>` branch and installs the hook.
Each machine pushes independently; the Worker discovers every `data-*` branch
and merges them, so no Worker configuration changes are needed.

## Configuration

Environment variables read by the agent scripts:

| Variable | Used by | Meaning |
|---|---|---|
| `CC_PROGRESS_OWNER` | `setup.sh`, `install-machine.sh` | GitHub username that owns the private repository (required) |
| `CC_PROGRESS_REPO` | `setup.sh`, `install-machine.sh` | Name of the private repository (required) |
| `CC_PROGRESS_MACHINE` | `setup.sh`, `install-machine.sh`, `reader.py` | Label for this machine; defaults to the short hostname. Stored in `~/.claude/cc-progress/.machine`. |
| `CC_PROGRESS_CLAUDE_DIR` | `reader.py` | Location of the Claude Code data directory if it is not `~/.claude` |
| `CC_PROGRESS_HEARTBEAT_SECS` | `run.sh` | Push even when nothing changed after this many seconds (default 600), so "updated … ago" stays accurate on an idle machine |
| `CC_PROGRESS_PASSWORD` | `server.py` | Password for local-only mode |

Worker settings in `wrangler.toml` under `[vars]`: `GH_OWNER`, `GH_REPO`,
`DATA_PREFIX` (default `data-`), `OVERLAY_BRANCH` (default `overlay`). Worker
secrets, set in the Cloudflare dashboard and never committed: `GH_TOKEN`,
`SITE_PASSWORD`.

## Local preview and local-only mode

**Preview the front-end with no server at all.** `public/app.js` falls back to
`./data.json` when `/api/data` is unreachable:

```bash
python3 agent/reader.py --out public/data.json --no-cache
python3 -m http.server -d public 8000       # open http://localhost:8000/
```

Auto-refresh and edits are unavailable in this mode.

**Run the whole dashboard locally, without GitHub or Cloudflare.**
`agent/server.py` serves the same page, reads the logs live on each request and
stores edits in a local `overlay.json`. Run it from `~/.claude/cc-progress/`
after step 0 above:

```bash
python3 ~/.claude/cc-progress/server.py                    # http://127.0.0.1:8787/
python3 ~/.claude/cc-progress/server.py --host 0.0.0.0     # reachable on the LAN
```

The password comes from `CC_PROGRESS_PASSWORD`, or is generated on first run
and saved to `~/.claude/cc-progress/.site_password`. From another device:
`ssh -L 8787:localhost:8787 user@host`, then open `http://localhost:8787/`.
This mode shows one machine only.

## Privacy

Read this before publishing anything.

- **Prompts are never published.** The reader extracts only session titles,
  to-do text, the project's working-directory path and the current git branch
  name.
- **The working-directory path is a real absolute path** from your machine. It
  usually contains your OS username and may reveal a client, employer or
  project name. If that matters on a given machine, do not install the agent
  there, or use local-only mode instead.
- **Secret scrubbing is best-effort.** Known key formats (Anthropic, OpenAI,
  GitHub, AWS, Google) are redacted, and any value of 16 or more characters
  found in a `.env` file in a project directory is removed from published text.
  This is a safety net, not a guarantee — which is why prompts are excluded
  altogether.
- **Where the data lives.** In your private GitHub repository and, in transit,
  through your Cloudflare Worker — both under accounts you control. Nothing is
  sent anywhere else.
- **Access.** Every path, page and API alike, is behind `SITE_PASSWORD`. Anyone
  with the password can see everything. Cloudflare Access (per-user login) is
  an alternative, but requires a payment method on file with Cloudflare.
- **The token** is stored only in `~/.claude/cc-progress/.token` (mode 600) and
  as an encrypted Worker secret. It never appears in the repository or in the
  browser.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Banner "github-unavailable"; API returns 503 | The fine-grained token expired or is rate-limited. Generate a new one, then update `.token` on every machine and the Worker's `GH_TOKEN` secret. |
| The password is always rejected (401) | `SITE_PASSWORD` is not set on this Worker, or was set on a different Worker. |
| The dashboard stopped updating for one machine | Check `~/.claude/cc-progress/run.log` on that machine. Re-run `install-hook.sh` (idempotent) to confirm the hook is present, and check the token has not expired. |
| A machine shows up as `machine` | Its `.machine` file is missing and `hostname -s` returned nothing. Re-run `install-machine.sh` with an explicit label. |
| `setup.sh` fails with "Token cannot access" | The repository does not exist yet, the token is not scoped to it, or it lacks Contents: read and write. |
| The dashboard shows 0 projects | The reader could not find `~/.claude/projects`. Set `CC_PROGRESS_CLAUDE_DIR` if Claude Code keeps its data elsewhere. |

## Updating and uninstalling

**Update to a newer version** (after `setup.sh`, `origin` in the local clone
points at your private repository, so pull from this project and push to yours):

```bash
cd ~/.claude/cc-progress/repo
git pull https://github.com/manojitharaju016/claude-code-progress.git main
git push origin main                                   # Cloudflare redeploys from main
cp agent/*.sh agent/*.py ~/.claude/cc-progress/        # refresh the local agent copy
```

**Remove one machine:** delete its `data-<machine>` branch on GitHub and remove
the Stop hook entry from that machine's `~/.claude/settings.json`.

**Uninstall completely:** remove the Stop hook entry from
`~/.claude/settings.json` on every machine, delete `~/.claude/cc-progress/`,
delete the Worker in Cloudflare, and delete the private repository.

## License

MIT — see [LICENSE](LICENSE).
