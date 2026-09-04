#!/usr/bin/env python3
"""
cc-progress reader — turns local Claude Code activity into one small progress.json.

Runs on this machine, standard library only.
It reads the Claude Code session logs under ~/.claude/projects, pulls out the
latest to-do list + auto-title per session, works out which sessions are live,
and compiles a compact progress tree the website renders.

Design notes:
  * To-do lists are matched on the STRUCTURAL marker  "name":"TodoWrite"
    (a real tool call), never the bare word "TodoWrite" — that word also appears
    in Claude Code's own reminder text and tool-availability lists, usually AFTER
    the last real call, which would otherwise report an empty (0%) stage.
  * Prompts are NEVER published (they can contain pasted secrets). Stage titles
    fall back to the live session name, then "Untitled session".
  * Liveness requires /proc/<pid>/cmdline to contain "claude" — not merely that
    the PID exists (session files are never cleaned up and PIDs get reused).

Usage:
    python3 reader.py --out progress.json      # write compiled tree
    python3 reader.py --summary                # human-readable summary to stdout
    python3 reader.py --out progress.json --summary
    python3 reader.py --out progress.json --metrics-out metrics.json
    python3 reader.py --backfill              # one-off full metrics scan, with progress
"""

import argparse
import glob
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone

import metrics_scan

HOME = os.path.expanduser("~")
# Override if your Claude Code config lives somewhere other than ~/.claude.
CLAUDE_DIR = os.environ.get("CC_PROGRESS_CLAUDE_DIR") or os.path.join(HOME, ".claude")
PROJECTS_DIR = os.path.join(CLAUDE_DIR, "projects")
SESSIONS_DIR = os.path.join(CLAUDE_DIR, "sessions")
CC_DIR = os.path.join(CLAUDE_DIR, "cc-progress")
CACHE_FILE = os.path.join(CC_DIR, "cache.json")
METRICS_CACHE_FILE = os.path.join(CC_DIR, "metrics_cache.json")
MACHINE_FILE = os.path.join(CC_DIR, ".machine")


def _machine_name():
    """This machine's short label, used to namespace projects + the data branch.
    Order: env override -> ~/.claude/cc-progress/.machine -> short hostname."""
    env = os.environ.get("CC_PROGRESS_MACHINE")
    if env:
        return env.strip()
    try:
        with open(MACHINE_FILE) as fh:
            v = fh.read().strip()
            if v:
                return v
    except OSError:
        pass
    return (socket.gethostname() or "machine").split(".")[0].lower()


MACHINE = _machine_name()
SCHEMA_VERSION = 1
# Bumped whenever the published metrics record changes shape, so the site can
# tell an old machine's feed from a new one instead of merging them blindly.
READER_VERSION = "2.0.0"

REVERSE_WINDOW = 8 * 1024 * 1024   # read at most the last 8 MB of a log
CACHE_VERSION = 4                   # bump: added run_started_ts + earliest-first_ts fix

# Byte markers used to cheaply pre-filter lines before json.loads.
B_TODOWRITE = b'"name":"TodoWrite"'
B_AITITLE = b'"type":"ai-title"'
B_ASSISTANT = b'"type":"assistant"'
B_USER = b'"type":"user"'

# --- secret scrubbing -------------------------------------------------------

_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"AIza[0-9A-Za-z_\-]{20,}"),
]


def build_secret_denyset(cwds):
    """Collect exact secret values from .env files in the given working dirs.

    Values are kept in memory only and used to scrub published text. The .env
    files themselves are never copied out.
    """
    values = set()
    checked = set()
    candidates = set(cwds)
    for cwd in candidates:
        if not cwd or cwd in checked:
            continue
        checked.add(cwd)
        env_path = os.path.join(cwd, ".env")
        try:
            with open(env_path, "r", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    _, _, val = line.partition("=")
                    val = val.strip().strip('"').strip("'")
                    if len(val) >= 16:
                        values.add(val)
        except (OSError, UnicodeError):
            continue
    return values


def scrub(text, denyset):
    """Best-effort redaction. Not a guarantee — which is why prompts are never
    published in the first place."""
    if not text:
        return text
    for val in denyset:
        if val and val in text:
            text = text.replace(val, "«redacted»")
    for pat in _SECRET_PATTERNS:
        text = pat.sub("«redacted»", text)
    return text


# --- log parsing ------------------------------------------------------------

def _extract_todos(obj):
    """Return the todos list from a parsed assistant line that holds a real
    TodoWrite tool_use, or None."""
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    if not isinstance(content, list):
        return None
    for block in content:
        if (
            isinstance(block, dict)
            and block.get("type") == "tool_use"
            and block.get("name") == "TodoWrite"
        ):
            todos = block.get("input", {}).get("todos")
            if isinstance(todos, list):
                return todos
    return None


def reverse_lines(path, size, window=REVERSE_WINDOW):
    """Yield complete lines (bytes) from a file, newest-first, over the last
    `window` bytes. A leading partial line is dropped when we didn't start at
    byte 0."""
    read_start = max(0, size - window)
    with open(path, "rb") as fh:
        fh.seek(read_start)
        data = fh.read()
    lines = data.split(b"\n")
    if read_start > 0 and lines:
        lines = lines[1:]  # first line is partial
    for line in reversed(lines):
        if line.strip():
            yield line


def forward_todos_fallback(path):
    """Full forward scan, only json-parsing lines that carry the structural
    TodoWrite marker. Used if the reverse window missed the last real call."""
    result = None
    try:
        with open(path, "rb") as fh:
            for line in fh:
                if B_TODOWRITE in line:
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    todos = _extract_todos(obj)
                    if todos is not None:
                        result = todos  # keep last (newest)
    except OSError:
        pass
    return result


def head_first_timestamp(path, window=256 * 1024):
    """The earliest ISO timestamp in a transcript = when the session started.
    Read only the head of the file (cheap)."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(window)
    except OSError:
        return None
    # take the EARLIEST timestamp in the window, not merely the first line that has
    # one — log lines are not guaranteed to be in chronological order.
    best = None
    for line in data.split(b"\n"):
        if b'"timestamp"' in line:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            ts = o.get("timestamp")
            if ts and (best is None or ts < best):
                best = ts
    return best


def scan_transcript(path, size):
    """Extract the latest real to-do list, ai-title, and newest metadata from a
    single session log. Returns a derived dict (values unscrubbed)."""
    todos = None
    ai_title = None
    meta = {}
    found_todos = found_title = found_meta = False

    for line in reverse_lines(path, size):
        if not found_todos and B_TODOWRITE in line:
            try:
                obj = json.loads(line)
            except ValueError:
                obj = None
            if obj is not None:
                t = _extract_todos(obj)
                if t is not None:
                    todos = t
                    found_todos = True
                    if not found_meta:
                        meta = _meta_from(obj)
                        found_meta = bool(meta.get("sessionId"))
        if not found_title and B_AITITLE in line:
            try:
                obj = json.loads(line)
            except ValueError:
                obj = None
            if obj is not None and obj.get("type") == "ai-title":
                ai_title = obj.get("aiTitle")
                found_title = True
        if not found_meta and (B_ASSISTANT in line or B_USER in line):
            try:
                obj = json.loads(line)
            except ValueError:
                obj = None
            if obj is not None and obj.get("type") in ("assistant", "user"):
                m = _meta_from(obj)
                if m.get("sessionId"):
                    meta = m
                    found_meta = True
        if found_todos and found_title and found_meta:
            break

    if not found_todos:
        fb = forward_todos_fallback(path)
        if fb is not None:
            todos = fb

    return {
        "todos": todos or [],
        "ai_title": ai_title,
        "session_id": meta.get("sessionId"),
        "cwd": meta.get("cwd"),
        "git_branch": meta.get("gitBranch"),
        "latest_ts": meta.get("timestamp"),   # last activity (most recent turn)
        "first_ts": head_first_timestamp(path),  # session start
    }


def _meta_from(obj):
    return {
        "sessionId": obj.get("sessionId"),
        "cwd": obj.get("cwd"),
        "gitBranch": obj.get("gitBranch"),
        "timestamp": obj.get("timestamp"),
    }


# --- liveness ---------------------------------------------------------------

def _pid_is_claude(pid):
    """Is this PID a running Claude Code process? Cross-platform:
    Linux reads /proc; macOS (no /proc) falls back to `ps`. Verifying the command
    (not just that the PID exists) avoids false 'live' on PID reuse."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    proc = "/proc/%d/cmdline" % pid
    if os.path.exists(proc):  # Linux
        try:
            with open(proc, "rb") as fh:
                return b"claude" in fh.read().lower()
        except OSError:
            return False
    try:  # macOS / other
        out = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                             capture_output=True, timeout=3).stdout
        return b"claude" in out.lower()
    except (OSError, subprocess.SubprocessError):
        return False


def live_sessions():
    """Map sessionId -> {cwd, startedAt, name} for Claude processes that are
    genuinely running right now."""
    live = {}
    for f in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        try:
            with open(f, "r", errors="replace") as fh:
                obj = json.load(fh)
        except (OSError, ValueError):
            continue
        pid = obj.get("pid")
        sid = obj.get("sessionId")
        if not pid or not sid:
            continue
        if not _pid_is_claude(pid):
            continue
        live[sid] = {
            "cwd": obj.get("cwd"),
            "startedAt": obj.get("startedAt"),
            "name": obj.get("name"),
        }
    return live


# --- cache ------------------------------------------------------------------

def load_cache():
    try:
        with open(CACHE_FILE, "r") as fh:
            c = json.load(fh)
        if c.get("_version") == CACHE_VERSION:
            return c
    except (OSError, ValueError):
        pass
    return {"_version": CACHE_VERSION}


def save_cache(cache):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(cache, fh)
        os.replace(tmp, CACHE_FILE)
    except OSError:
        pass


def publish_excerpts():
    return os.environ.get("CC_PROGRESS_PUBLISH_EXCERPTS", "").strip() in ("1", "true", "yes")


def load_metrics_cache():
    """Metrics state lives in its own file so the to-do cache stays small and
    is not rewritten with accumulator state after every turn.

    Turning the prompt excerpt on or off has to invalidate it. A settled file
    keeps only its finished record, so without this the setting would apply to
    sessions scanned from now on and silently skip the rest.
    """
    fresh = {"_version": metrics_scan.METRICS_CACHE_VERSION,
             "_excerpts": publish_excerpts()}
    try:
        with open(METRICS_CACHE_FILE, "r") as fh:
            c = json.load(fh)
        if (c.get("_version") == metrics_scan.METRICS_CACHE_VERSION
                and bool(c.get("_excerpts")) == fresh["_excerpts"]):
            return c
    except (OSError, ValueError):
        pass
    return fresh


def save_metrics_cache(cache):
    cache["_excerpts"] = publish_excerpts()
    try:
        os.makedirs(os.path.dirname(METRICS_CACHE_FILE), exist_ok=True)
        tmp = METRICS_CACHE_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(cache, fh)
        os.replace(tmp, METRICS_CACHE_FILE)
    except OSError:
        pass


def build_metrics_tree(budget_secs, show_progress=False):
    """Compile the prompting-metrics feed. Returns (tree, stats)."""
    cache = load_metrics_cache()
    cwds = set()
    for entry in cache.values():
        if isinstance(entry, dict):
            acc = entry.get("acc") or entry.get("final") or {}
            if isinstance(acc, dict) and acc.get("cwd"):
                cwds.add(acc["cwd"])
    denyset = build_secret_denyset(cwds)
    publish = publish_excerpts()

    def _progress(done, total, path):
        if show_progress:
            pct = 100.0 * done / total if total else 100.0
            sys.stderr.write("\r  scanning %d of %d files (%.0f%%)      " % (done, total, pct))
            sys.stderr.flush()

    tree, stats = metrics_scan.build_metrics(
        PROJECTS_DIR, cache, MACHINE, READER_VERSION,
        scrub=lambda t: scrub(t, denyset),
        publish_excerpt=publish,
        budget_secs=budget_secs,
        progress=_progress if show_progress else None,
        judge_dir=os.path.join(CC_DIR, "judge"),
    )
    if show_progress:
        sys.stderr.write("\n")
    save_metrics_cache(cache)
    return tree, stats


# --- compile ----------------------------------------------------------------

_ROOT_CACHE = {}


def project_root(cwd):
    """The folder that counts as ONE project for a session's working directory.

    1. The git repository root, if the path is inside a repo (`.git` may be a dir
       or a file — worktrees/submodules use a file).
    2. Otherwise the top-level folder inside the home directory, so
       `~/myproject/subdir/whatever` groups under `~/myproject` instead of
       appearing as its own project.
    3. Otherwise the path unchanged (e.g. /mnt/data/alice).
    """
    if not cwd:
        return cwd
    if cwd in _ROOT_CACHE:
        return _ROOT_CACHE[cwd]

    result = None
    p = os.path.normpath(cwd)
    while True:
        if os.path.exists(os.path.join(p, ".git")):
            result = p
            break
        parent = os.path.dirname(p)
        if parent == p or p in (os.sep, ""):
            break
        p = parent

    if result is None:
        home = os.path.normpath(HOME)
        norm = os.path.normpath(cwd)
        if norm == home:
            result = norm
        elif norm.startswith(home + os.sep):
            first = norm[len(home) + 1:].split(os.sep)[0]
            result = os.path.join(home, first)
        else:
            result = norm

    _ROOT_CACHE[cwd] = result
    return result


def fingerprint(text):
    norm = " ".join((text or "").lower().split())
    return hashlib.sha1(norm.encode("utf-8", "replace")).hexdigest()[:12]


def top_level_transcripts():
    out = []
    if not os.path.isdir(PROJECTS_DIR):
        return out
    for d in sorted(glob.glob(os.path.join(PROJECTS_DIR, "*"))):
        if os.path.isdir(d):
            out.extend(sorted(glob.glob(os.path.join(d, "*.jsonl"))))
    return out


def build(cache):
    live = live_sessions()
    derived = []
    seen_cwds = set()

    for path in top_level_transcripts():
        try:
            st = os.stat(path)
        except OSError:
            continue
        sig = {"size": st.st_size, "mtime_ns": st.st_mtime_ns}
        entry = cache.get(path)
        if entry and entry.get("size") == sig["size"] and entry.get("mtime_ns") == sig["mtime_ns"]:
            d = entry["d"]
        else:
            d = scan_transcript(path, st.st_size)
            cache[path] = {"size": sig["size"], "mtime_ns": sig["mtime_ns"], "d": d}
        if d.get("cwd"):
            seen_cwds.add(d["cwd"])
        derived.append(d)

    denyset = build_secret_denyset(seen_cwds)

    # newest live session -> foreground
    fg_sid = None
    fg_ts = None
    for d in derived:
        sid = d.get("session_id")
        if sid in live and d.get("latest_ts"):
            if fg_ts is None or d["latest_ts"] > fg_ts:
                fg_ts = d["latest_ts"]
                fg_sid = sid

    projects = {}
    for d in derived:
        cwd = d.get("cwd")
        sid = d.get("session_id")
        if not cwd or not sid:
            continue
        root = project_root(cwd)
        pkey = "%s::%s" % (MACHINE, root)
        proj = projects.get(pkey)
        if proj is None:
            proj = {
                "key": pkey,
                "machine": MACHINE,
                "cwd": root,
                "name": os.path.basename(root.rstrip("/")) or root,
                "stages": [],
            }
            projects[pkey] = proj

        subtasks = []
        num_done = 0
        for t in d["todos"]:
            status = t.get("status", "pending")
            if status == "completed":
                num_done += 1
            subtasks.append({
                "key": fingerprint(t.get("content", "")),
                "text": scrub(t.get("content", ""), denyset),
                "status": status,
            })
        num_todos = len(subtasks)
        progress = round(100.0 * num_done / num_todos, 1) if num_todos else None

        info = live.get(sid)
        title = d.get("ai_title")
        if not title:
            title = (info or {}).get("name") or "Untitled session"

        # When the session is running NOW, the elapsed clock must measure the CURRENT
        # process, not the transcript's first line — a resumed session would otherwise
        # read "running 21d". startedAt is unix ms from ~/.claude/sessions/<pid>.json.
        run_started_ts = None
        started_at = (info or {}).get("startedAt")
        if started_at:
            try:
                run_started_ts = datetime.fromtimestamp(
                    float(started_at) / 1000.0, timezone.utc
                ).isoformat().replace("+00:00", "Z")
            except (TypeError, ValueError, OSError, OverflowError):
                run_started_ts = None

        stage = {
            "key": sid,
            "title": scrub(title, denyset),
            "running": sid in live,
            "foreground": sid == fg_sid,
            "progress": progress,
            "num_todos": num_todos,
            "num_done": num_done,
            "latest_ts": d.get("latest_ts"),
            "started_ts": d.get("first_ts"),      # when this session's history begins
            "run_started_ts": run_started_ts,     # when the CURRENT process started
            "git_branch": d.get("git_branch"),
            # the session's own folder, relative to the project root — so a session
            # that ran in a subfolder still shows where it actually was
            "subpath": (os.path.relpath(cwd, root) if cwd != root else ""),
            "subtasks": subtasks,
        }
        proj["stages"].append(stage)

    # roll up project + overall stats
    proj_list = []
    for proj in projects.values():
        total_tasks = sum(s["num_todos"] for s in proj["stages"])
        total_done = sum(s["num_done"] for s in proj["stages"])
        proj["progress"] = round(100.0 * total_done / total_tasks, 1) if total_tasks else None
        proj["num_stages"] = len(proj["stages"])
        proj["num_active"] = sum(1 for s in proj["stages"] if s["running"])
        proj["num_done_stages"] = sum(1 for s in proj["stages"] if s["progress"] == 100.0)
        proj["last_ts"] = max((s.get("latest_ts") or "" for s in proj["stages"]), default="") or None
        proj["started_ts"] = min((s.get("started_ts") or "9999" for s in proj["stages"]), default="") or None
        if proj["started_ts"] == "9999":
            proj["started_ts"] = None
        proj["stages"].sort(
            key=lambda s: (s["foreground"], s["running"], s["latest_ts"] or ""),
            reverse=True,
        )
        proj_list.append(proj)

    proj_list.sort(
        key=lambda p: (
            any(s["foreground"] for s in p["stages"]),
            p["num_active"],
            max((s["latest_ts"] or "" for s in p["stages"]), default=""),
        ),
        reverse=True,
    )

    fg_project_key = None
    for p in proj_list:
        if any(s["foreground"] for s in p["stages"]):
            fg_project_key = p["key"]
            break

    return {
        "schema_version": SCHEMA_VERSION,
        "machine": MACHINE,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "projects": len(proj_list),
            "active_projects": sum(1 for p in proj_list if p["num_active"] > 0),
            "stages": sum(p["num_stages"] for p in proj_list),
        },
        "foreground": {"project_key": fg_project_key, "stage_key": fg_sid},
        "projects": proj_list,
    }


def summarize(tree):
    lines = []
    c = tree["counts"]
    lines.append("machine=%s  projects=%d  active_projects=%d  stages=%d  (generated %s)" % (
        tree["machine"], c["projects"], c["active_projects"], c["stages"], tree["generated_utc"]))
    for p in tree["projects"]:
        prog = "n/a" if p["progress"] is None else ("%.0f%%" % p["progress"])
        lines.append("\n[%s]  %s  (%d stages, %d live)" % (prog, p["name"], p["num_stages"], p["num_active"]))
        for s in p["stages"]:
            sp = "n/a" if s["progress"] is None else ("%.0f%%" % s["progress"])
            flag = " *LIVE*" if s["running"] else ""
            flag += " <FG>" if s["foreground"] else ""
            lines.append("    [%s] %s  (%d/%d)%s" % (sp, s["title"][:70], s["num_done"], s["num_todos"], flag))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="write compiled progress.json to this path")
    ap.add_argument("--summary", action="store_true", help="print human summary")
    ap.add_argument("--no-cache", action="store_true", help="ignore/skip the cache")
    ap.add_argument("--metrics-out", help="write the prompting-metrics feed to this path")
    ap.add_argument("--metrics-budget", type=float, default=None,
                    help="seconds to spend scanning transcripts for metrics (default 20; "
                         "unscanned files are picked up on the next run)")
    ap.add_argument("--backfill", action="store_true",
                    help="scan every transcript for metrics with no time budget, printing "
                         "progress. Run this once by hand after upgrading; the hook path "
                         "stays budgeted so a turn is never held up.")
    args = ap.parse_args(argv)

    if args.backfill and not args.metrics_out:
        args.metrics_out = os.path.join(CC_DIR, "datapush", "data", "metrics.json")

    cache = {"_version": CACHE_VERSION} if args.no_cache else load_cache()
    tree = build(cache)
    if not args.no_cache:
        save_cache(cache)

    if args.metrics_out:
        budget = 0 if args.backfill else (
            args.metrics_budget if args.metrics_budget is not None
            else float(os.environ.get("CC_PROGRESS_METRICS_BUDGET_SECS", "20")))
        mtree, mstats = build_metrics_tree(budget, show_progress=args.backfill)
        tmp = args.metrics_out + ".tmp"
        os.makedirs(os.path.dirname(os.path.abspath(args.metrics_out)), exist_ok=True)
        with open(tmp, "w") as fh:
            json.dump(mtree, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, args.metrics_out)
        sys.stderr.write(
            "wrote %s  (%d sessions, scanned %d, deferred %d, %.1fs)\n" % (
                args.metrics_out, mstats["sessions"], mstats["scanned"],
                mstats["skipped"], mstats["secs"]))

    if args.out:
        tmp = args.out + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(tree, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, args.out)
        sys.stderr.write("wrote %s\n" % args.out)
    if args.summary or not args.out:
        print(summarize(tree))
    return 0


if __name__ == "__main__":
    sys.exit(main())
