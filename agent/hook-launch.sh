#!/usr/bin/env bash
# Claude Code Stop-hook entry point.
# Detaches the real worker (run.sh) and returns IMMEDIATELY, so the turn is never
# blocked by the compile/push. Reads nothing from stdin; gives the child no stdin.
ROOT="$HOME/.claude/cc-progress"
# detach so the turn is never blocked. setsid on Linux; nohup fallback on macOS.
if command -v setsid >/dev/null 2>&1; then
  setsid bash "$ROOT/run.sh" </dev/null >/dev/null 2>&1 &
else
  nohup bash "$ROOT/run.sh" </dev/null >/dev/null 2>&1 &
fi
disown 2>/dev/null || true
exit 0
