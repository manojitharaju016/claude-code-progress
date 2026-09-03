#!/usr/bin/env bash
# Per-turn worker for cc-progress: compile progress.json, and if it changed,
# force-push a single rolling commit to the `data` branch.
#
# Launched DETACHED by hook-launch.sh so it never blocks a Claude Code turn.
# Always exits 0. Single-flight via flock. Logs to run.log (size-rotated).
set -uo pipefail

ROOT="$HOME/.claude/cc-progress"
PY="$(command -v python3 || echo /usr/bin/python3)"
DATAPUSH="$ROOT/datapush"
OUT="$DATAPUSH/data/progress.json"
LOG="$ROOT/run.log"
LOCK="$ROOT/.lock"
HASHFILE="$ROOT/.last_hash"
# this machine pushes ONLY to its own branch, so machines never clobber each other
MACHINE="$(cat "$ROOT/.machine" 2>/dev/null || hostname -s 2>/dev/null || echo machine)"
BRANCH="data-$MACHINE"

# rotate log at ~1 MB (wc -c is portable; GNU stat -c / BSD stat -f differ)
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$LOG" "$LOG.1" 2>/dev/null || true
fi

# single-flight lock — flock on Linux, mkdir-lock everywhere else (macOS has no flock)
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" || exit 0
  if ! flock -n 9; then echo "$(date -u +%FT%TZ) skip: locked" >>"$LOG"; exit 0; fi
else
  if ! mkdir "$LOCK.d" 2>/dev/null; then echo "$(date -u +%FT%TZ) skip: locked" >>"$LOG"; exit 0; fi
  trap 'rmdir "$LOCK.d" 2>/dev/null || true' EXIT
fi

{
  echo "$(date -u +%FT%TZ) start"

  if [ ! -d "$DATAPUSH/.git" ]; then
    echo "datapush not set up yet (run setup.sh) — nothing to do"
    exit 0
  fi
  mkdir -p "$DATAPUSH/data"

  if ! "$PY" "$ROOT/reader.py" --out "$OUT" 2>>"$LOG"; then
    echo "reader failed"
    exit 0
  fi

  # meaningful-change check: hash the tree WITHOUT the generated_utc timestamp,
  # so a no-op turn does not cause a needless push.
  NEWHASH="$("$PY" - "$OUT" <<'PYHASH'
import json,hashlib,sys
d=json.load(open(sys.argv[1]))
d.pop("generated_utc",None)
print(hashlib.sha1(json.dumps(d,sort_keys=True,ensure_ascii=False).encode("utf-8")).hexdigest())
PYHASH
)"
  OLDHASH="$(cat "$HASHFILE" 2>/dev/null || echo none)"
  # Heartbeat: even when nothing changed, push if the last push is older than
  # HEARTBEAT_SECS. Without this, "updated X ago" on the dashboard ages forever on
  # an idle machine and looks broken/stale when the pipeline is actually healthy.
  HEARTBEAT_SECS=${CC_PROGRESS_HEARTBEAT_SECS:-600}
  NOW_EPOCH=$(date -u +%s)
  LAST_EPOCH=$(cat "$ROOT/.last_push_epoch" 2>/dev/null || echo 0)
  AGE=$(( NOW_EPOCH - LAST_EPOCH ))
  if [ "$NEWHASH" = "$OLDHASH" ] && [ "$AGE" -lt "$HEARTBEAT_SECS" ]; then
    echo "no meaningful change (last push ${AGE}s ago); skip push"
    exit 0
  fi
  if [ "$NEWHASH" = "$OLDHASH" ]; then
    echo "no content change but last push ${AGE}s ago -> heartbeat push"
  fi

  cd "$DATAPUSH" || exit 0
  git add data/progress.json 2>>"$LOG"
  # single rolling commit: amend if one exists, else create.
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    git commit --amend --no-edit -q 2>>"$LOG" || true
  else
    git commit -q -m "progress" 2>>"$LOG" || true
  fi

  ok=0
  for i in 1 2 3; do
    if git push --force origin "HEAD:$BRANCH" 2>>"$LOG"; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" = 1 ]; then
    echo "$NEWHASH" > "$HASHFILE"
    date -u +%s > "$ROOT/.last_push_epoch"
    date -u +%FT%TZ > "$ROOT/last_push_utc"
    echo "pushed ok"
  else
    echo "push failed after retries"
  fi
} >>"$LOG" 2>&1

exit 0
