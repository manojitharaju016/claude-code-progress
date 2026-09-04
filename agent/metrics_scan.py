#!/usr/bin/env python3
"""
cc-progress metrics scanner — walks transcripts once, then only the new bytes.

Transcripts are append-only while a session runs, so this keeps a byte offset
and the folded accumulator state per file. A later run parses only what was
added. Anything that breaks that assumption (the file shrank, its head changed,
the offset does not land just after a newline) falls back to a full rescan, so
a wrong answer is never preferred to a slow one.

The to-do scanner in reader.py is untouched: it reads backwards from the end and
stops early, which is right for its job and wrong for this one. Metrics need
every line, so they get their own pass and their own cache file.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import time
from datetime import datetime, timedelta, timezone

import metrics

METRICS_CACHE_VERSION = 1
METRICS_SCHEMA_VERSION = metrics.METRICS_SCHEMA_VERSION

# Only these lines can carry a signal. Everything else (attachments other than a
# queued command, ai-title, file-history, worktree state) is skipped before the
# JSON parser sees it, which is most of the file.
# Written without a space after the colon by Claude Code today; both spellings
# are accepted so a serialiser change cannot silently empty the whole feed.
def _both_spellings(*markers):
    out = []
    for m in markers:
        out.append(m.encode())
        out.append(m.replace('":"', '": "').encode())
    return tuple(out)


PREFILTERS = _both_spellings(
    '"type":"assistant"',
    '"type":"user"',
    '"compact_boundary"',
    '"type":"pr-link"',
    '"type":"continued-in"',
    '"queued_command"',
)

HEAD_BYTES = 4096
KEEP_STATE_SECS = 24 * 3600     # after a day idle, keep only the finished record
DEFAULT_WINDOW_DAYS = 365
DEFAULT_BUDGET_SECS = 20.0


def _head_hash(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha1(fh.read(HEAD_BYTES)).hexdigest()[:16]
    except OSError:
        return None


def _iter_records(fh):
    """Yield parsed records for lines that pass the byte prefilter.

    Returns through the generator; the caller reads fh.tell() afterwards, so the
    loop must stop cleanly on a partial final line.
    """
    for raw in fh:
        if not raw.endswith(b"\n"):
            return                      # a half-written line: leave it for next run
        if not any(m in raw for m in PREFILTERS):
            continue
        try:
            yield json.loads(raw)
        except ValueError:
            continue


def scan_file(path, entry, size, mtime_ns):
    """Fold one transcript into an accumulator state, resuming when it is safe."""
    head = _head_hash(path)
    off = 0
    state = None
    if entry:
        same_head = entry.get("head") == head and head is not None
        prev_off = entry.get("off") or 0
        if same_head and prev_off and size >= prev_off and entry.get("acc"):
            if _byte_before_is_newline(path, prev_off):
                off, state = prev_off, entry.get("acc")

    acc = metrics.SessionAccumulator(state)
    consumed = off
    try:
        with open(path, "rb") as fh:
            fh.seek(off)
            for rec in _iter_records(fh):
                acc.feed(rec)
            consumed = fh.tell()
    except OSError:
        return None
    # Trim back to the last complete line so a resume never starts mid-record.
    consumed = _last_newline_at_or_before(path, consumed)
    return {"size": size, "mtime_ns": mtime_ns, "head": head, "off": consumed,
            "acc": acc.state()}


def _byte_before_is_newline(path, off):
    if off <= 0:
        return False
    try:
        with open(path, "rb") as fh:
            fh.seek(off - 1)
            return fh.read(1) == b"\n"
    except OSError:
        return False


def _last_newline_at_or_before(path, off):
    if off <= 0:
        return 0
    try:
        with open(path, "rb") as fh:
            fh.seek(off - 1)
            if fh.read(1) == b"\n":
                return off
            back = max(0, off - 65536)
            fh.seek(back)
            chunk = fh.read(off - back)
        idx = chunk.rfind(b"\n")
        return back + idx + 1 if idx >= 0 else 0
    except OSError:
        return 0


def scan_subagent(path, entry, size, mtime_ns, agent_type):
    head = _head_hash(path)
    off, state = 0, None
    if entry and entry.get("head") == head and entry.get("acc"):
        prev_off = entry.get("off") or 0
        if prev_off and size >= prev_off and _byte_before_is_newline(path, prev_off):
            off, state = prev_off, entry["acc"]
    sub = metrics.SubagentAccumulator(state)
    sub.agent_type = agent_type or (state or {}).get("agent_type")
    consumed = off
    try:
        with open(path, "rb") as fh:
            fh.seek(off)
            for rec in _iter_records(fh):
                sub.feed(rec)
            consumed = fh.tell()
    except OSError:
        return None
    consumed = _last_newline_at_or_before(path, consumed)
    return {"size": size, "mtime_ns": mtime_ns, "head": head, "off": consumed,
            "acc": sub.state()}


def _agent_type(path):
    meta = path[:-len(".jsonl")] + ".meta.json"
    try:
        with open(meta) as fh:
            return (json.load(fh) or {}).get("agentType")
    except (OSError, ValueError):
        return None


def session_files(projects_dir):
    """Depth-1 files only. Everything deeper is a subagent transcript."""
    out = []
    for d in sorted(glob.glob(os.path.join(projects_dir, "*"))):
        if os.path.isdir(d):
            out.extend(sorted(glob.glob(os.path.join(d, "*.jsonl"))))
    return out


def subagent_files(projects_dir):
    """(parent session id, path) for every subagent transcript, at both depths."""
    out = []
    for pattern in ("*/*/subagents/agent-*.jsonl",
                    "*/*/subagents/workflows/*/agent-*.jsonl"):
        for p in sorted(glob.glob(os.path.join(projects_dir, pattern))):
            parts = p.split(os.sep)
            try:
                sid = parts[parts.index("subagents") - 1]
            except ValueError:
                continue
            out.append((sid, p))
    return out


def load_judgements(judge_dir):
    """Verdicts from the judge-sessions skill, plus the latest coach note."""
    verdicts, coach = {}, None
    try:
        with open(os.path.join(judge_dir, "judge_cache.json")) as fh:
            for sid, entry in (json.load(fh) or {}).items():
                if isinstance(entry, dict) and entry.get("result"):
                    r = dict(entry["result"])
                    r.pop("sid", None)
                    r["judged_by"] = entry.get("judged_by") or r.get("judged_by")
                    r["judged_at"] = entry.get("at")
                    verdicts[sid] = r
    except (OSError, ValueError):
        pass
    notes = sorted(glob.glob(os.path.join(judge_dir, "coach", "*.json")))
    if notes:
        try:
            with open(notes[-1]) as fh:
                coach = json.load(fh)
            coach["date"] = os.path.basename(notes[-1])[:-5]
        except (OSError, ValueError):
            coach = None
    return verdicts, coach


def build_metrics(projects_dir, cache, machine, reader_version,
                  scrub=None, publish_excerpt=False,
                  budget_secs=DEFAULT_BUDGET_SECS, window_days=DEFAULT_WINDOW_DAYS,
                  progress=None, judge_dir=None):
    """Compile every session into one compact tree. Returns (tree, stats)."""
    started = time.time()
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=window_days)).isoformat()

    files = session_files(projects_dir)
    subs = subagent_files(projects_dir)
    scanned = skipped = 0

    # Subagent totals first, so a session can carry its delegation cost.
    sub_by_sid = {}
    now_s = time.time()
    for sid, path in subs:
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = "S:" + path
        entry = cache.get(key)
        unchanged = (entry and entry.get("size") == st.st_size
                     and entry.get("mtime_ns") == st.st_mtime_ns)
        if unchanged:
            state = entry.get("acc") or entry.get("final")
        elif budget_secs and (now_s - started) > budget_secs:
            skipped += 1                      # picked up on a later run
            state = (entry or {}).get("acc") or (entry or {}).get("final")
            if not state:
                continue
        else:
            fresh = scan_subagent(path, entry, st.st_size, st.st_mtime_ns, _agent_type(path))
            if not fresh:
                continue
            cache[key] = fresh
            entry = fresh
            state = fresh["acc"]
            scanned += 1
        # A subagent transcript that has not changed for a day is finished. Keep
        # its totals and drop the message-id set, which is almost all of its
        # bulk; if it somehow changes later, the missing offset forces a full
        # rescan rather than a resume that could double-count.
        if entry and entry.get("acc") and (now_s - st.st_mtime_ns / 1e9) > KEEP_STATE_SECS:
            slim = dict(entry["acc"])
            slim["seen"] = []
            entry["final"] = slim
            entry["acc"] = None
            entry["off"] = 0
        sub_by_sid.setdefault(sid, []).append(state)

    sessions = []
    for i, path in enumerate(files):
        try:
            st = os.stat(path)
        except OSError:
            continue
        entry = cache.get(path)
        fresh_needed = not (entry and entry.get("size") == st.st_size
                            and entry.get("mtime_ns") == st.st_mtime_ns)
        if fresh_needed:
            if budget_secs and (time.time() - started) > budget_secs and entry:
                skipped += 1                     # keep last run's answer, retry next run
                fresh_needed = False
            elif budget_secs and (time.time() - started) > budget_secs:
                skipped += 1
                continue
        if fresh_needed:
            fresh = scan_file(path, entry, st.st_size, st.st_mtime_ns)
            if not fresh:
                continue
            entry = fresh
            entry["final"] = None
            cache[path] = entry
            scanned += 1
            if progress:
                progress(i + 1, len(files), path)

        state = entry.get("acc")
        if state is None and entry.get("final"):
            rec = entry["final"]                  # settled long ago; state was dropped
        else:
            acc = metrics.SessionAccumulator(state)
            sid = state.get("sid") if state else None
            for sub_state in sub_by_sid.get(sid or "", []):
                acc.add_subagent(sub_state)
            rec = acc.finalize(scrub=scrub, publish_excerpt=publish_excerpt)
            entry["final"] = rec
            # An idle file will not change again: keep the finished record and
            # drop the fold state. A later change finds no state and rescans in
            # full, which is slower but can never double-count.
            if entry.get("mtime_ns") and (now_s - entry["mtime_ns"] / 1e9) > KEEP_STATE_SECS:
                entry["acc"] = None
                entry["off"] = 0
        if rec.get("sid"):
            sessions.append(rec)

    _link_resumes(sessions)

    verdicts, coach = load_judgements(judge_dir) if judge_dir else ({}, None)
    judge_tokens = 0
    for rec in sessions:
        v = verdicts.get(rec.get("sid"))
        if v:
            rec["j"] = v
        if rec.get("kind") == "judge":
            # What the coaching itself costs, so the price is on the dashboard
            # rather than in a footnote.
            for b in (rec.get("by_model") or {}).values():
                judge_tokens += b.get("in", 0) + b.get("cc5", 0) + b.get("cc1h", 0) + b.get("cr", 0) + b.get("out", 0)

    recent, lifetime = [], {"sessions": 0, "by_model": {}}
    for rec in sessions:
        lifetime["sessions"] += 1
        for model, b in (rec.get("by_model") or {}).items():
            dst = lifetime["by_model"].setdefault(
                model, {"calls": 0, "in": 0, "cc5": 0, "cc1h": 0, "cr": 0, "out": 0, "think": 0, "fast_calls": 0})
            for k, v in b.items():
                dst[k] = dst.get(k, 0) + v
        if (rec.get("latest_ts") or "") >= cutoff:
            recent.append(rec)

    recent.sort(key=lambda r: r.get("latest_ts") or "", reverse=True)
    tree = {
        "schema_version": METRICS_SCHEMA_VERSION,
        "reader_version": reader_version,
        "machine": machine,
        "generated_utc": now.isoformat(),
        "window_days": window_days,
        "excerpts_published": bool(publish_excerpt),
        "sessions": recent,
        "lifetime": lifetime,
        "judged": len(verdicts),
        "judge_tokens": judge_tokens,
        "coach": coach,
    }
    return tree, {"scanned": scanned, "skipped": skipped, "sessions": len(recent),
                  "files": len(files), "subagents": len(subs),
                  "secs": round(time.time() - started, 1)}


def _link_resumes(sessions):
    """A session that another one continued into knows it was a continuation."""
    by_sid = {}
    for rec in sessions:
        if rec.get("sid"):
            by_sid[rec["sid"]] = rec
    for rec in sessions:
        nxt = rec.get("continued_in")
        if nxt and nxt in by_sid:
            by_sid[nxt]["resumed_from"] = rec["sid"]
