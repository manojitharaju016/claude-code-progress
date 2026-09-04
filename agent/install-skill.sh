#!/usr/bin/env bash
# Install the judge-sessions skill so `/judge-sessions` works in Claude Code.
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)/skills/judge-sessions"
DEST="${CC_PROGRESS_CLAUDE_DIR:-$HOME/.claude}/skills/judge-sessions"
mkdir -p "$DEST"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"
echo "installed $DEST/SKILL.md"
echo
echo "Judge a few sessions now:      /judge-sessions"
echo "Keep it running in the background:  /loop 30m /judge-sessions"
