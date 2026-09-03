#!/usr/bin/env bash
# "Go live" step: add a SECOND Stop hook to ~/.claude/settings.json that launches
# the cc-progress reader after every Claude Code turn. Your existing Stop hook
# (update_vault.sh) is preserved. A timestamped backup is written first.
# Re-running is safe (it won't add a duplicate).
set -euo pipefail
SETTINGS="$HOME/.claude/settings.json"
LAUNCH="$HOME/.claude/cc-progress/hook-launch.sh"
PY="$(command -v python3 || echo /usr/bin/python3)"
[ -f "$LAUNCH" ] || { echo "ERROR: missing $LAUNCH (run the machine setup step first)"; exit 1; }
[ -x "$LAUNCH" ] || chmod +x "$LAUNCH"
mkdir -p "$HOME/.claude"
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.bak.$(date -u +%Y%m%dT%H%M%SZ)"
else
  echo '{}' > "$SETTINGS"   # first-time: create a minimal settings file
fi

"$PY" - "$SETTINGS" "$LAUNCH" <<'PY'
import json,sys
path,launch=sys.argv[1],sys.argv[2]
cfg=json.load(open(path))
hooks=cfg.setdefault("hooks",{})
stop=hooks.setdefault("Stop",[])
# already installed?
def has(cmd):
    for group in stop:
        for h in group.get("hooks",[]):
            if h.get("command")==cmd: return True
    return False
if has(launch):
    print("already installed; no change")
else:
    stop.append({"hooks":[{"type":"command","command":launch,"timeout":5}]})
    json.dump(cfg,open(path,"w"),indent=2)
    print("added Stop hook ->",launch)
PY
echo "Done. New Claude Code turns on this machine will now update the dashboard."
echo "To undo: remove that entry from $SETTINGS (a .bak was saved)."
