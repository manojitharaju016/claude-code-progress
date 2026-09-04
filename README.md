# Work Progress

A private dashboard for your own Claude Code sessions. It answers two questions:

**What am I working on?** Every machine you use reports its projects, sessions
and to-do lists to one page, so you can see what is running and what is left.

**How well am I asking for it?** The same transcripts already record where you
interrupted, turned down an edit, rejected a plan or repeated yourself. The
Prompting view turns that into findings with your own numbers: what happened,
what to try instead, and how much to trust it.

Everything runs on your machines and a Cloudflare Worker you own. No third-party
service sees your work.

![views](docs/views.png)

## How it works

```
~/.claude/projects/**/*.jsonl        your transcripts, read locally
        │
        ├─ reader.py + metrics.py    run after every turn, via a Stop hook
        │                            writes progress.json and metrics.json
        ▼
   data-<machine> branch             one rolling commit, force-pushed
        │
        ▼
   Cloudflare Worker                 merges every machine, behind a password
        │
        ▼
   the page                          Progress and Prompting
```

Reading a transcript costs about half a second once the cache is warm, and only
the bytes added since the last run are parsed.

## What you need

- A GitHub account and a private repository for the data.
- A free Cloudflare account.
- Python 3.9 or newer, and git. Nothing else to install.

## Setting it up

1. **Fork or clone this repository** into a private repo of your own. The data
   lives in the same repo on its own branches, so it must stay private.

2. **Create the Worker.** In the Cloudflare dashboard, Workers & Pages → Create →
   Workers → connect to Git, and point it at your repo's `main`. Then edit
   `wrangler.toml` and set `GH_OWNER` and `GH_REPO` to your own.

3. **Add two secrets** in the Worker's settings (Variables and Secrets, type
   Secret, never in the file):

   | Name | What it is |
   |---|---|
   | `GH_TOKEN` | A fine-grained GitHub token for this repo only, Contents: read and write |
   | `SITE_PASSWORD` | The password you will type to open the page |

4. **Install on each machine:**

   ```bash
   git clone https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO ~/cc-progress-src
   cd ~/cc-progress-src/agent
   ./setup.sh              # copies the scripts, sets the machine name, first push
   ./install-hook.sh       # runs the reader after every Claude Code turn
   ./install-skill.sh      # adds /judge-sessions
   ```

   Then load your page, type the password, and your work appears.

## Reviewing your sessions

Findings that need a reading rather than a count, such as *why* a correction
happened, come from Claude Code itself rather than an API key. In any Claude
Code session:

```
/judge-sessions              review a few finished sessions now
/loop 30m /judge-sessions    keep going in the background
```

It reads finished sessions only, at most a few at a time, and writes a short
structured verdict per session. Nothing is sent anywhere: the digests it reads
are built locally, with secrets stripped, and the results stay in your repo.

The dashboard shows what this has cost in tokens, so you can decide whether to
keep it running.

## Settings

Put these in `~/.claude/cc-progress/config.env` on any machine.

| Setting | Default | What it does |
|---|---|---|
| `CC_PROGRESS_MACHINE` | your hostname | The name this machine reports under. |
| `CC_PROGRESS_PUBLISH_EXCERPTS` | off | Publish the first 200 characters of each session's opening message, after scrubbing. Off means no prompt text ever leaves the machine. |
| `CC_PROGRESS_METRICS_BUDGET_SECS` | `20` | How long the reader may spend on new transcripts per turn. Anything it does not reach is picked up next time. |
| `CC_PROGRESS_HEARTBEAT_SECS` | `600` | Push even when nothing changed, so the page does not look stale. |
| `CC_PROGRESS_CLAUDE_DIR` | `~/.claude` | Where your Claude Code data lives. |

After upgrading, run the one-off scan of your history:

```bash
python3 ~/.claude/cc-progress/reader.py --backfill
```

## What leaves your machine

Only `data/progress.json` and `data/metrics.json`, pushed to your own private
repo. Between them they contain:

- Project paths, git branch names, session titles and to-do text.
- Counts: messages, tool calls, tokens, interruptions, rejected edits and plans.
- Timestamps, and a context-size curve of at most 32 points per session.
- Session reviews, if you run `/judge-sessions`: a score, labels and a summary of
  at most 140 characters that is rejected if it quotes you.
- The opening 200 characters of first messages, **only** if you turn that on.

Before anything is published it passes a scrubber that removes API keys, GitHub
tokens and AWS keys by pattern, plus every value found in a `.env` file in a
directory you have worked in. Prompts, tool output and file contents are never
published.

## Keeping an eye on it

```bash
python3 ~/.claude/cc-progress/reader.py --summary    # what it sees right now
python3 ~/.claude/cc-progress/judge.py status        # reviews done and pending
tail -f ~/.claude/cc-progress/run.log                # every push
```

| Problem | Usually |
|---|---|
| The page says nothing is there | The first push has not happened. Send a message in any Claude Code session and wait a few seconds. |
| One machine is missing | Its reader is older than the site expects. Re-run `setup.sh` there; the page names it under the machine chips. |
| The charts do not load | Something is blocking cdnjs. Every chart has a **Show the numbers** button that works regardless. |
| The Prompting view is mostly locked | It needs about five sessions per group, and a few reviewed ones. Keep working, and run `/judge-sessions`. |

## Tests

```bash
python3 -m unittest discover -s tests    # the reader and the reviewer
node --test tests/*.test.mjs             # the Worker and the findings
```

## Removing it

```bash
~/.claude/cc-progress/install-hook.sh --uninstall
rm -rf ~/.claude/cc-progress ~/.claude/skills/judge-sessions
```

Delete the Worker and the repository to remove the published copy.

## Licence

MIT.
