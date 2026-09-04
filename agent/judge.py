#!/usr/bin/env python3
"""
cc-progress judge — prepares sessions for review, then ingests the verdicts.

Deterministic signals can count corrections but cannot say WHY one happened:
a gap in the prompt, the model going wrong with a clear ask, the person
changing their mind, or the environment failing. That attribution is the part
worth acting on, and it needs a reader.

The reading is done by Claude Code itself, through the `judge-sessions` skill,
so it runs on the plan you already pay for and no API key is involved. This
file is the plumbing on either side of that, and it never touches the network:

    judge.py queue    build digests of sessions that are ready to review
    judge.py ingest   validate the returned verdicts and file them
    judge.py status   what is judged, pending, rejected, and what it cost

Nothing that leaves this file has been near an unscrubbed prompt: digests are
built from scrubbed, truncated turns with reminder blocks stripped, and a
returned summary that echoes the person's own wording is rejected.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics
import metrics_scan
import reader as R

JUDGE_DIR = os.path.join(R.CC_DIR, "judge")
QUEUE_FILE = os.path.join(JUDGE_DIR, "judge_queue.json")
CACHE_FILE = os.path.join(JUDGE_DIR, "judge_cache.json")
INBOX_DIR = os.path.join(JUDGE_DIR, "inbox")
REJECT_DIR = os.path.join(INBOX_DIR, "rejected")
COACH_DIR = os.path.join(JUDGE_DIR, "coach")

DEFAULT_LIMIT = 3
DEFAULT_SINCE_DAYS = 90
IDLE_HOURS = 6
MAX_TURNS_IN_DIGEST = 40
HUMAN_CHARS = 400
CLAUDE_CHARS = 200
MIN_NEW_TURNS = 3
MAX_ATTEMPTS = 2
REJUDGE_HOURS = 24
COACH_EVERY = 10

LABELS = ("new_task", "approval", "answer", "correction", "scope_change",
          "interrupt", "re_explain", "other")
CAUSES = ("prompt_gap", "model_error", "scope_change", "env_issue", "context_loss")
MISSING = ("files/locations", "expected output shape", "acceptance check",
           "constraints", "current state", "scope bound", "priority")
OUTCOMES = ("completed", "partial", "abandoned", "unclear")
RUBRIC = ("goal", "context", "constraints", "done_criterion", "scope")

# Reminder and command blocks are harness text, not the person's words.
RE_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
RE_TAGGED = re.compile(r"<(command-[\w-]+|local-command-[\w-]+|ide_[\w-]+|task-notification)>.*?</\1>", re.S)

DIGEST_PREFILTERS = metrics_scan._both_spellings(
    '"type":"assistant"', '"type":"user"', '"compact_boundary"', '"queued_command"')


def _now():
    return datetime.now(timezone.utc)


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _clean(text, denyset, limit):
    """Scrub, strip harness blocks, collapse whitespace, truncate."""
    text = RE_REMINDER.sub(" ", text or "")
    text = RE_TAGGED.sub(" ", text)
    text = R.scrub(" ".join(text.split()), denyset)
    return text[:limit]


def build_digest(path, denyset):
    """An ordered, redacted sketch of one session: what was asked, what happened."""
    turns = []
    pending = {"tools": {}, "flags": []}
    last_text = ""
    total_human = 0

    def flush_into(turn):
        turn["claude"] = {
            "said": last_text[:CLAUDE_CHARS],
            "tools": dict(sorted(pending["tools"].items(), key=lambda kv: -kv[1])[:6]),
            "flags": sorted(set(pending["flags"])),
        }

    try:
        fh = open(path, "rb")
    except OSError:
        return None
    with fh:
        for raw in fh:
            if not any(m in raw for m in DIGEST_PREFILTERS):
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            rtype = rec.get("type")
            if rtype == "assistant":
                msg = rec.get("message") or {}
                for b in msg.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use":
                        n = b.get("name") or "?"
                        pending["tools"][n] = pending["tools"].get(n, 0) + 1
                    elif b.get("type") == "text" and isinstance(b.get("text"), str):
                        last_text = " ".join(b["text"].split())
            elif rtype == "attachment":
                if (rec.get("attachment") or {}).get("type") == "queued_command":
                    pending["flags"].append("you sent a message mid-turn")
            elif rtype == "system" and rec.get("subtype") == "compact_boundary":
                pending["flags"].append("context was compacted here")
            elif rtype == "user":
                denial = rec.get("toolDenialKind")
                if denial == "user-rejected":
                    pending["flags"].append("you rejected a tool call or edit")
                elif denial == "permission-rule":
                    pending["flags"].append("a permission rule blocked a call")
                msg = rec.get("message") or {}
                text = metrics._text_of(msg.get("content"))
                if text.lstrip().startswith(metrics.INTERRUPT_PREFIX):
                    pending["flags"].append("you interrupted the run")
                    continue
                if not metrics.is_human_turn(rec):
                    continue
                total_human += 1
                if turns:
                    flush_into(turns[-1])
                turns.append({"i": total_human, "you": _clean(text, denyset, HUMAN_CHARS)})
                last_text = ""
                pending = {"tools": {}, "flags": []}
    if turns:
        flush_into(turns[-1])
    if not turns:
        return None

    omitted = 0
    if len(turns) > MAX_TURNS_IN_DIGEST:
        omitted = len(turns) - MAX_TURNS_IN_DIGEST
        turns = turns[-MAX_TURNS_IN_DIGEST:]
    return {"turns": turns, "omitted_earlier_turns": omitted, "human_turns": total_human}


def _session_index():
    """Every scanned session: its finished metrics record and its transcript path."""
    cache = _load(os.path.join(R.CC_DIR, "metrics_cache.json"), {})
    out = {}
    for path, entry in cache.items():
        if not isinstance(entry, dict) or path.startswith("S:"):
            continue
        rec = entry.get("final")
        if not rec:
            acc = entry.get("acc")
            rec = metrics.SessionAccumulator(acc).finalize() if acc else None
        if rec and rec.get("sid"):
            out[rec["sid"]] = (rec, path)
    return out


def _is_closed(rec, live_sids):
    if rec.get("continued_in"):
        return True
    if rec["sid"] in live_sids:
        return False
    ts = metrics.parse_ts(rec.get("latest_ts"))
    return bool(ts and (_now() - ts) > timedelta(hours=IDLE_HOURS))


def cmd_queue(args):
    index = _session_index()
    cache = _load(CACHE_FILE, {})
    live = set(live_ids())
    cutoff = (_now() - timedelta(days=args.since)).isoformat()

    ready = []
    for sid, (rec, path) in index.items():
        if rec.get("kind") == "judge":
            continue                                   # never let it grade itself
        if (rec.get("human_turns") or 0) < 2:
            continue                                   # nothing to review
        if (rec.get("latest_ts") or "") < cutoff:
            continue
        if not _is_closed(rec, live):
            continue
        prior = cache.get(sid)
        if prior:
            if (prior.get("attempts") or 0) >= MAX_ATTEMPTS and not prior.get("result"):
                continue
            if prior.get("result"):
                grown = rec["human_turns"] - (prior.get("n_turns") or 0)
                if grown < MIN_NEW_TURNS:
                    continue
            at = metrics.parse_ts(prior.get("at"))
            if at and (_now() - at) < timedelta(hours=REJUDGE_HOURS):
                continue
        ready.append((rec.get("latest_ts") or "", sid, rec, path))

    ready.sort(reverse=True)
    pending = len(ready)
    picked = ready[:args.limit]

    denyset = R.build_secret_denyset({r.get("cwd") for _, _, r, _ in picked if r.get("cwd")})
    items, est = [], 0
    for _, sid, rec, path in picked:
        digest = build_digest(path, denyset)
        if not digest:
            continue
        chars = sum(len(t.get("you", "")) + len(t["claude"]["said"]) for t in digest["turns"])
        est += chars // 4 + 400
        items.append({
            "sid": sid,
            "n_turns": rec["human_turns"],
            "project": os.path.basename((rec.get("cwd") or "").rstrip("/")),
            "started": rec.get("started_ts"),
            "signals": {k: rec.get(k, 0) for k in
                        ("interrupts", "denied_user", "denied_plan", "steering",
                         "lex_corrections", "reexplain", "askuser")},
            "compactions": len(rec.get("compactions") or []),
            "digest": digest,
        })
    _save(QUEUE_FILE, {"generated": _now().isoformat(), "items": items})
    print("%d queued, %d pending, ~%d tokens" % (len(items), pending - len(items), est))
    return 0


def live_ids():
    try:
        return set(R.live_sessions().keys())
    except Exception:
        return set()


# ------------------------------------------------------------------ ingest

def _shingle_overlap(summary, digest):
    """A summary that borrows the person's own wording is not a summary."""
    s = metrics.shingles(summary or "")
    if not s:
        return False
    for t in (digest or {}).get("turns", []):
        if s & metrics.shingles(t.get("you", "")):
            return True
    return False


def validate(result, queued):
    """Return a list of problems. An empty list means the verdict is usable."""
    problems = []
    if not isinstance(result, dict):
        return ["not a JSON object"]
    if result.get("sid") != queued["sid"]:
        problems.append("sid does not match the queued session")
    if result.get("n_turns") != queued["n_turns"]:
        problems.append("n_turns %r does not match the queued %r"
                        % (result.get("n_turns"), queued["n_turns"]))
    turns = result.get("turns")
    if not isinstance(turns, list) or not turns:
        problems.append("turns must be a non-empty list")
    else:
        for t in turns:
            if not isinstance(t, dict):
                problems.append("a turn is not an object")
                break
            if t.get("label") not in LABELS:
                problems.append("unknown label %r" % (t.get("label"),))
                break
            if t.get("cause") is not None and t.get("cause") not in CAUSES:
                problems.append("unknown cause %r" % (t.get("cause"),))
                break
            if not isinstance(t.get("i"), int) or t["i"] < 1:
                problems.append("turn index must be a positive integer")
                break
    fp = result.get("first_prompt")
    if not isinstance(fp, dict) or any(not isinstance(fp.get(k), bool) for k in RUBRIC):
        problems.append("first_prompt needs booleans for: " + ", ".join(RUBRIC))
    else:
        score = result.get("score")
        expect = sum(1 for k in RUBRIC if fp[k])
        if score != expect:
            problems.append("score %r does not match the %d rubric items marked true"
                            % (score, expect))
    miss = result.get("missing")
    if not isinstance(miss, list) or any(m not in MISSING for m in miss):
        problems.append("missing[] must come from the fixed vocabulary")
    if result.get("outcome") not in OUTCOMES:
        problems.append("unknown outcome %r" % (result.get("outcome"),))
    summary = result.get("summary")
    if not isinstance(summary, str) or len(summary) > 140:
        problems.append("summary must be a string of at most 140 characters")
    elif _shingle_overlap(summary, queued.get("digest")):
        problems.append("summary quotes the person's own wording")
    return problems


def cmd_ingest(args):
    queue = _load(QUEUE_FILE, {"items": []})
    queued = {it["sid"]: it for it in queue.get("items", [])}
    cache = _load(CACHE_FILE, {})
    ok = bad = 0
    os.makedirs(REJECT_DIR, exist_ok=True)

    for path in sorted(glob.glob(os.path.join(INBOX_DIR, "*.json"))):
        sid = os.path.basename(path)[:-5]
        result = _load(path, None)
        item = queued.get(sid)
        if item is None:
            _reject(path, sid, ["session was not in the current queue"])
            bad += 1
            continue
        problems = validate(result, item)
        prior = cache.get(sid, {})
        if problems:
            cache[sid] = {"n_turns": item["n_turns"], "at": _now().isoformat(),
                          "attempts": (prior.get("attempts") or 0) + 1,
                          "result": prior.get("result")}
            _reject(path, sid, problems)
            bad += 1
            continue
        cache[sid] = {"n_turns": item["n_turns"], "at": _now().isoformat(),
                      "attempts": (prior.get("attempts") or 0) + 1,
                      "judged_by": result.get("judged_by") or "claude-code",
                      "result": result}
        os.remove(path)
        ok += 1

    _save(CACHE_FILE, cache)
    print("%d ingested, %d rejected" % (ok, bad))
    return 0


def _reject(path, sid, problems):
    os.makedirs(REJECT_DIR, exist_ok=True)
    dest = os.path.join(REJECT_DIR, os.path.basename(path))
    try:
        os.replace(path, dest)
    except OSError:
        pass
    with open(dest + ".why.txt", "w") as fh:
        fh.write("%s rejected:\n- %s\n" % (sid, "\n- ".join(problems)))


def cmd_status(args):
    cache = _load(CACHE_FILE, {})
    judged = [v for v in cache.values() if v.get("result")]
    index = _session_index()
    live = set(live_ids())
    eligible = sum(1 for sid, (rec, _) in index.items()
                   if rec.get("kind") != "judge" and (rec.get("human_turns") or 0) >= 2
                   and _is_closed(rec, live))
    rejected = len(glob.glob(os.path.join(REJECT_DIR, "*.json")))
    inbox = len(glob.glob(os.path.join(INBOX_DIR, "*.json")))
    coach = sorted(glob.glob(os.path.join(COACH_DIR, "*.json")))
    since_coach = len(judged) - _coach_watermark(coach)
    print("judged %d of %d eligible sessions; %d awaiting ingest, %d rejected" % (
        len(judged), eligible, inbox, rejected))
    print("judge sessions cost so far: see the dashboard (sessions tagged kind=judge)")
    if since_coach >= COACH_EVERY:
        print("coach note due: %d sessions judged since the last one" % since_coach)
    else:
        print("coach note in %d more judged sessions" % max(0, COACH_EVERY - since_coach))
    return 0


def _coach_watermark(coach_files):
    if not coach_files:
        return 0
    return (_load(coach_files[-1], {}) or {}).get("judged_total", 0)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="cmd")
    q = sub.add_parser("queue", help="build digests for sessions ready to review")
    q.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    q.add_argument("--since", type=int, default=DEFAULT_SINCE_DAYS,
                   help="only sessions active in the last N days (default 90)")
    q.set_defaults(fn=cmd_queue)
    i = sub.add_parser("ingest", help="validate and file the returned verdicts")
    i.set_defaults(fn=cmd_ingest)
    s = sub.add_parser("status", help="what is judged, pending and rejected")
    s.set_defaults(fn=cmd_status)
    args = ap.parse_args(argv)
    if not getattr(args, "fn", None):
        ap.print_help()
        return 2
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
