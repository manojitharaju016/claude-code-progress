#!/usr/bin/env bash
# Set up cc-progress on THIS machine so its Claude Code sessions show on the
# dashboard. Idempotent. Needs: reader.py, run.sh, hook-launch.sh, install-hook.sh
# and .token already present in ~/.claude/cc-progress/ (copied here by the rollout).
#
# Usage:  CC_PROGRESS_OWNER=you CC_PROGRESS_REPO=work-progress CC_PROGRESS_MACHINE=laptop bash install-machine.sh
#     or: CC_PROGRESS_OWNER=you CC_PROGRESS_REPO=work-progress bash install-machine.sh laptop
set -euo pipefail

OWNER="${CC_PROGRESS_OWNER:?set your GitHub username, e.g. CC_PROGRESS_OWNER=you}"
REPO="${CC_PROGRESS_REPO:?set your repo name, e.g. CC_PROGRESS_REPO=work-progress}"
ROOT="$HOME/.claude/cc-progress"
DATAPUSH="$ROOT/datapush"
TOKENFILE="$ROOT/.token"
PY="$(command -v python3 || echo /usr/bin/python3)"

# Portable `git init` with an initial branch name: `-b` needs git >= 2.28.
git_init_branch() { # usage: git_init_branch <branch>   (run with cwd already set)
  git init -q -b "$1" 2>/dev/null && return
  git init -q
  git symbolic-ref HEAD "refs/heads/$1"
}

MACHINE="${1:-${CC_PROGRESS_MACHINE:-$(hostname -s 2>/dev/null || hostname)}}"
MACHINE="$(printf '%s' "$MACHINE" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9._-')"
[ -n "$MACHINE" ] || { echo "could not determine machine name"; exit 1; }
BRANCH="data-$MACHINE"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[ -f "$TOKENFILE" ] || { echo "ERROR: missing $TOKENFILE"; exit 1; }
chmod 600 "$TOKENFILE"
[ -f "$ROOT/reader.py" ] || { echo "ERROR: missing $ROOT/reader.py"; exit 1; }

printf '%s' "$MACHINE" > "$ROOT/.machine"
# Path is %q-escaped before splicing into the helper's own embedded shell
# command, so this still works if $HOME contains a space.
TOKENFILE_Q="$(printf '%q' "$TOKENFILE")"
HELPER='!f() { echo username=x-access-token; echo "password=$(tr -d " \n\r\t" < '"$TOKENFILE_Q"')"; }; f'
REMOTE="https://github.com/${OWNER}/${REPO}.git"

say "Machine label: $MACHINE   (branch: $BRANCH)"

say "Setting up push clone ..."
rm -rf "$DATAPUSH"
mkdir -p "$DATAPUSH/data"
cd "$DATAPUSH"
git_init_branch "$BRANCH"
git config credential.helper "$HELPER"
git config user.email "cc-progress@localhost"
git config user.name "cc-progress"
git remote add origin "$REMOTE"
CC_PROGRESS_MACHINE="$MACHINE" "$PY" "$ROOT/reader.py" --out "$DATAPUSH/data/progress.json"
git add data/progress.json
git commit -q -m "progress"
git push --force origin "HEAD:$BRANCH"

say "Installing the Stop hook (keeps any existing hooks) ..."
bash "$ROOT/install-hook.sh"

say "Done. $MACHINE now reports to the dashboard. Test: bash $ROOT/run.sh && tail $ROOT/run.log"
