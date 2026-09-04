#!/usr/bin/env bash
# One-time setup for your own private Work Progress dashboard.
#
# PREREQUISITES (do these first — see README.md):
#   1. Create an EMPTY private GitHub repo:  <OWNER>/<REPO>  (below).
#   2. Create a FINE-GRAINED token scoped to ONLY that repo, permission
#      "Contents: Read and write", and save it to  ~/.claude/cc-progress/.token
#      (this script will chmod it 600).
#
# What this does (all via that fine-grained token — no broad access used):
#   - pushes the website (public/, src/, wrangler.toml) to the `main` branch
#   - creates this machine's `data-<machine>` branch with an initial progress.json
#   - creates the `overlay` branch with an empty overlay.json (your edits go here)
#   - sets up ~/.claude/cc-progress/datapush as the reader's push clone
# It does NOT install the Stop hook and does NOT touch Cloudflare — those are
# separate, confirmed steps.
set -euo pipefail

OWNER="${CC_PROGRESS_OWNER:?set your GitHub username first, e.g.: CC_PROGRESS_OWNER=you CC_PROGRESS_REPO=work-progress bash setup.sh}"
REPO="${CC_PROGRESS_REPO:?set your repo name first, e.g.: CC_PROGRESS_OWNER=you CC_PROGRESS_REPO=work-progress bash setup.sh}"
OVERLAY_BRANCH="overlay"

# This machine's label: CC_PROGRESS_MACHINE, else the short hostname. Every machine
# pushes to its own data-<machine> branch; run.sh reads the label back from .machine.
MACHINE="${CC_PROGRESS_MACHINE:-$(hostname -s 2>/dev/null || hostname)}"
MACHINE="$(printf '%s' "$MACHINE" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9._-')"
DATA_BRANCH="data-$MACHINE"

ROOT="$HOME/.claude/cc-progress"
SRC="$ROOT/repo"
DATAPUSH="$ROOT/datapush"
TOKENFILE="$ROOT/.token"
PY="$(command -v python3 || echo /usr/bin/python3)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Portable `git init` with an initial branch name: `-b` needs git >= 2.28.
git_init_branch() { # usage: git_init_branch <branch>   (run with cwd already set)
  git init -q -b "$1" 2>/dev/null && return
  git init -q
  git symbolic-ref HEAD "refs/heads/$1"
}

[ -f "$TOKENFILE" ] || die "Missing token file $TOKENFILE (see README step 2)."
chmod 600 "$TOKENFILE"
TOKEN="$(tr -d ' \n\r\t' < "$TOKENFILE")"
[ -n "$TOKEN" ] || die "Token file is empty."
[ -n "$MACHINE" ] || die "Could not determine a machine label; set CC_PROGRESS_MACHINE=<name>."
printf '%s' "$MACHINE" > "$ROOT/.machine"

# credential helper that feeds the fine-grained token from .token (keeps the
# token OUT of any .git/config URL). The path is %q-escaped before splicing into
# the helper's own embedded shell command, so this still works if $HOME contains
# a space.
TOKENFILE_Q="$(printf '%q' "$TOKENFILE")"
HELPER='!f() { echo username=x-access-token; echo "password=$(tr -d " \n\r\t" < '"$TOKENFILE_Q"')"; }; f'
REMOTE="https://github.com/${OWNER}/${REPO}.git"
GIT() { git -c credential.helper="$HELPER" "$@"; }

say "Checking token can reach ${OWNER}/${REPO} ..."
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${OWNER}/${REPO}")"
[ "$code" = "200" ] || die "Token cannot access ${OWNER}/${REPO} (HTTP $code). Create the repo and scope the token to it."

# --- main branch (website) ---
say "Pushing website to main ..."
cd "$SRC"
if [ ! -d .git ]; then git_init_branch main; fi
git add -A
git -c user.email="cc-progress@localhost" -c user.name="cc-progress" commit -q -m "site: work progress dashboard" || true
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"
GIT push -u origin main

# --- data branch (reader output) via the datapush clone ---
say "Creating datapush clone + $DATA_BRANCH branch (machine label: $MACHINE) ..."
rm -rf "$DATAPUSH"
mkdir -p "$DATAPUSH/data"
cd "$DATAPUSH"
git_init_branch "$DATA_BRANCH"
git config credential.helper "$HELPER"
git config user.email "cc-progress@localhost"
git config user.name "cc-progress"
git remote add origin "$REMOTE"
CC_PROGRESS_MACHINE="$MACHINE" "$PY" "$ROOT/reader.py" --out "$DATAPUSH/data/progress.json"
git add data/progress.json
git commit -q -m "progress"
git push --force -u origin "$DATA_BRANCH"

# --- overlay branch (your edits) ---
say "Creating overlay branch ..."
TMP="$(mktemp -d)"
cd "$TMP"
git_init_branch "$OVERLAY_BRANCH"
mkdir -p data
printf '{\n  "schema_version": 1,\n  "projects": {},\n  "stages": {},\n  "subtasks": {}\n}\n' > data/overlay.json
git -c user.email="cc-progress@localhost" -c user.name="cc-progress" add data/overlay.json
git -c user.email="cc-progress@localhost" -c user.name="cc-progress" commit -q -m "overlay: empty"
git remote add origin "$REMOTE"
GIT push -u origin "$OVERLAY_BRANCH"
cd "$ROOT"; rm -rf "$TMP"

chmod 700 "$ROOT" 2>/dev/null || true
say "Done. Repo has 3 branches: main (site), $DATA_BRANCH (this machine's progress), overlay (your edits)."
echo
echo "Next: (A) set up the Cloudflare Worker (see README section 'Cloudflare')."
echo "      (B) when ready to go live, install the Stop hook (see README 'Go live')."
echo "You can test the reader push now with:  bash $ROOT/run.sh && cat $ROOT/run.log"
