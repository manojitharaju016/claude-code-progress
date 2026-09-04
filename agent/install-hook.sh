#!/usr/bin/env bash
# "Go live" step: add a Stop hook to ~/.claude/settings.json that launches the
# cc-progress reader after every Claude Code turn. Any Stop hooks you already have
# are preserved. A timestamped backup of settings.json is written first.
# Re-running is safe (it won't add a duplicate).
set -eu

if [ "${1:-}" = "--uninstall" ]; then
  SETTINGS="${CC_PROGRESS_CLAUDE_DIR:-$HOME/.claude}/settings.json"
  [ -f "$SETTINGS" ] || { echo "no settings file at $SETTINGS; nothing to remove"; exit 0; }
  cp "$SETTINGS" "$SETTINGS.bak"
  "$(command -v python3 || echo /usr/bin/python3)" - "$SETTINGS" <<'PY'
import json, sys
path = sys.argv[1]
cfg = json.load(open(path))
groups = cfg.get("hooks", {}).get("Stop", [])
kept, removed = [], 0
for g in groups:
    hooks = [h for h in g.get("hooks", []) if "cc-progress" not in str(h.get("command", ""))]
    removed += len(g.get("hooks", [])) - len(hooks)
    if hooks:
        g["hooks"] = hooks
        kept.append(g)
if groups:
    cfg["hooks"]["Stop"] = kept
json.dump(cfg, open(path, "w"), indent=2)
print("removed %d hook(s)" % removed)
PY
  echo "Done. A .bak of your settings was saved next to it."
  exit 0
fi

set -eu -o pipefail
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
