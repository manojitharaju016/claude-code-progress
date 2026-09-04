#!/usr/bin/env python3
"""
cc-progress metrics — per-session prompting-practice signals from a transcript.

Standard library only, Python 3.9 compatible, and deliberately pure: every
function here takes parsed JSONL records and returns plain data, so the whole
module is unit-testable without a Claude directory, a network, or a clock.

What it measures, and why each signal is trustworthy:

  * Hard revisions are recorded by Claude Code itself, not inferred: a user
    record carrying `toolDenialKind`, a user text beginning "[Request
    interrupted by user", or an `attachment` whose `attachment.type` is
    "queued_command" (the mid-turn message injection). These are facts.
  * Possible corrections are a LEXICON match on the opening of a follow-up
    message. That is a guess, and every consumer must label it as one.
  * Re-explanation is a 6-word shingle repeat against earlier turns in the same
    session — also a proxy, labelled "repeated wording" wherever it surfaces.
  * Token usage comes from message.usage. One API message is written as several
    JSONL records that share message.id and repeat usage verbatim, so usage is
    counted once per message.id. Those records are usually adjacent, but after a
    compaction Claude Code REPLAYS the preserved segment, so the same id can
    reappear a thousand records later; the whole set of seen ids is kept rather
    than a sliding window, or a long session double-counts its own history.
    Context size at a call is
    input + cache_creation + cache_read; input_tokens alone is a two-digit
    number and is never the context.

Nothing here reads or returns prompt text unless finalize() is explicitly asked
for an excerpt, and even then it passes it through the caller's scrubber first.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

METRICS_SCHEMA_VERSION = 1

# ---------------------------------------------------------------- constants

# A follow-up whose opening looks like the user pushing back. A guess, not a fact.
LEX_CORRECTION = re.compile(
    r"^\s*(?:no|nope|wrong|stop|wait|don'?t|do not|actually|instead|revert|undo"
    r"|again|i said|i meant|that'?s not|not what i|you (?:should|were supposed)"
    r"|why did you)\b",
    re.I,
)
# "no worries" / "no problem" are agreement, not correction.
LEX_NOT_CORRECTION = re.compile(r"^\s*no (?:worries|problem|rush|hurry)\b", re.I)

# First-prompt shape flags. Patterns, not comprehension: they are named
# "detected by pattern" wherever they are shown.
RE_PATH = re.compile(r"(?:[\w.\-]+/[\w.\-/]+|\b[\w\-]+\.(?:py|js|ts|tsx|jsx|md|json|ya?ml|css|html|sh|toml|sql|txt|ipynb)\b)")
RE_CONSTRAINT = re.compile(r"\b(?:do not|don'?t|never|only|avoid|without|must not|except|keep|leave)\b", re.I)
RE_DONE = re.compile(r"\b(?:done when|verify|verified|test|tests|should|must|until|expect(?:ed)?|make sure|confirm|check that|passes|exit(?:s)? 0)\b", re.I)
RE_PLAN = re.compile(r"\b(?:plan|plan mode|design|approach|propose|outline)\b", re.I)

# Non-human user records: harness plumbing wearing a user role.
META_MARKERS = ("<command-name>", "<task-notification>", "<local-command-caveat>",
                "<local-command-stdout>", "<local-command-stderr>")
INTERRUPT_PREFIX = "[Request interrupted by user"

# Bash commands that count as running tests / committing, when the tool call
# did not come back an error.
RE_TEST_CMD = re.compile(r"\b(?:pytest|vitest|jest|go test|cargo test|npm (?:run )?test|yarn test|python -m unittest|tox|rspec|phpunit)\b")
RE_COMMIT_CMD = re.compile(r"\bgit\s+commit\b")

EDIT_TOOLS = ("Edit", "Write", "NotebookEdit", "MultiEdit")

# Model context windows, for "peak context as a share of the window".
MODEL_WINDOWS = (("haiku", 200000),)
DEFAULT_WINDOW = 1000000

ACTIVE_GAP_SECS = 10 * 60      # a pause longer than this is not working time
MAX_CTX_POINTS = 32            # downsample target for the context curve
MAX_SHINGLES = 6000            # cap the repeated-wording memory per session
EXCERPT_CHARS = 200
SHINGLE_N = 6


def model_window(model):
    if not model:
        return DEFAULT_WINDOW
    low = model.lower()
    for needle, win in MODEL_WINDOWS:
        if needle in low:
            return win
    return DEFAULT_WINDOW


def parse_ts(ts):
    """ISO-8601 with a Z suffix -> aware datetime. Python 3.9 cannot parse the Z."""
    if not ts or not isinstance(ts, str):
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _text_of(content):
    """The human-visible text of a message.content, which is a string or blocks."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for b in content:
        if isinstance(b, dict) and b.get("type") == "text":
            t = b.get("text")
            if isinstance(t, str):
                out.append(t)
    return "\n".join(out)


def _has_tool_result(content):
    if not isinstance(content, list):
        return False
    for b in content:
        if isinstance(b, dict) and b.get("type") == "tool_result":
            return True
    return False


def is_human_turn(rec):
    """A message the person actually typed, not harness plumbing or a tool result."""
    if rec.get("type") != "user" or rec.get("isSidechain"):
        return False
    if rec.get("isMeta") or rec.get("isCompactSummary"):
        return False
    msg = rec.get("message") or {}
    content = msg.get("content")
    if _has_tool_result(content):
        return False
    origin = rec.get("origin")
    if isinstance(origin, dict) and origin.get("kind") not in (None, "human"):
        return False
    text = _text_of(content)
    if not text.strip():
        return False
    if text.lstrip().startswith(INTERRUPT_PREFIX):
        return False
    for marker in META_MARKERS:
        if marker in text:
            return False
    return True


def shingles(text, n=SHINGLE_N):
    """Hashed n-word shingles, for detecting that a turn repeats an earlier one."""
    words = text.lower().split()
    if len(words) < n:
        return set()
    out = set()
    for i in range(len(words) - n + 1):
        out.add(hash_str(" ".join(words[i:i + n])))
    return out


def hash_str(s):
    """A small stable hash. Not security; just a compact shingle identity."""
    h = 2166136261
    for ch in s.encode("utf-8", "replace"):
        h = ((h ^ ch) * 16777619) & 0xFFFFFFFF
    return h


def downsample(points, target=MAX_CTX_POINTS):
    """Keep the shape and both ends of a series, in at most `target` points."""
    if len(points) <= target:
        return points
    step = (len(points) - 1) / float(target - 1)
    out = []
    for i in range(target):
        out.append(points[int(round(i * step))])
    # keep the true peak, which a stride can miss
    peak = max(points, key=lambda p: p[1])
    if peak not in out:
        out[len(out) // 2] = peak
        out.sort(key=lambda p: p[0])
    return out


def first_prompt_features(text):
    """Structural flags of an opening message. Patterns, never comprehension."""
    stripped = text.strip()
    return {
        "fp_words": len(stripped.split()),
        "has_path": bool(RE_PATH.search(stripped)),
        "has_constraint": bool(RE_CONSTRAINT.search(stripped)),
        "has_done_criterion": bool(RE_DONE.search(stripped)),
        "is_question": stripped.endswith("?") or bool(re.match(r"^\s*(?:what|why|how|where|when|which|who|is|are|does|do|can|could|should|would)\b", stripped, re.I)),
        "slash_cmd": stripped.startswith("/"),
        "mentions_plan": bool(RE_PLAN.search(stripped[:400])),
    }


class SubagentAccumulator(object):
    """Token and tool totals for one subagent transcript, rolled into its parent."""

    def __init__(self, state=None):
        s = state or {}
        self.seen = set(s.get("seen", []))
        self.by_model = dict(s.get("by_model", {}))
        self.tool_calls = s.get("tool_calls", 0)
        self.agent_type = s.get("agent_type")

    def feed(self, rec):
        if rec.get("type") != "assistant":
            return
        msg = rec.get("message") or {}
        mid = msg.get("id")
        if mid:
            if mid in self.seen:
                self._count_blocks(msg)
                return
            self.seen.add(mid)
        _add_usage(self.by_model, msg)
        self._count_blocks(msg)

    def _count_blocks(self, msg):
        for b in msg.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                self.tool_calls += 1

    def state(self):
        return {"seen": sorted(self.seen), "by_model": self.by_model,
                "tool_calls": self.tool_calls, "agent_type": self.agent_type}


def _add_usage(by_model, msg):
    """Fold one API message's usage into per-model buckets. Called once per id."""
    usage = msg.get("usage") or {}
    if not usage:
        return
    model = msg.get("model") or "unknown"
    b = by_model.get(model)
    if b is None:
        b = {"calls": 0, "in": 0, "cc5": 0, "cc1h": 0, "cr": 0, "out": 0,
             "think": 0, "fast_calls": 0}
        by_model[model] = b
    cc = usage.get("cache_creation") or {}
    details = usage.get("output_tokens_details") or {}
    b["calls"] += 1
    b["in"] += usage.get("input_tokens") or 0
    b["cc5"] += cc.get("ephemeral_5m_input_tokens") or 0
    b["cc1h"] += cc.get("ephemeral_1h_input_tokens") or 0
    b["cr"] += usage.get("cache_read_input_tokens") or 0
    b["out"] += usage.get("output_tokens") or 0
    b["think"] += details.get("thinking_tokens") or 0
    if usage.get("speed") == "fast":
        b["fast_calls"] += 1


def call_context(usage):
    """Context carried into one API call. input_tokens alone is not it."""
    if not usage:
        return 0
    cc = usage.get("cache_creation_input_tokens")
    if cc is None:
        c = usage.get("cache_creation") or {}
        cc = (c.get("ephemeral_5m_input_tokens") or 0) + (c.get("ephemeral_1h_input_tokens") or 0)
    return (usage.get("input_tokens") or 0) + (cc or 0) + (usage.get("cache_read_input_tokens") or 0)


class SessionAccumulator(object):
    """
    Folds one main transcript into a compact record.

    feed() is called once per parsed record in file order. state() serialises
    everything needed to resume mid-file, so a growing transcript is scanned
    once per appended byte rather than once per run.
    """

    def __init__(self, state=None):
        s = state or {}
        g = s.get
        self.sid = g("sid")
        self.cwd = g("cwd")
        self.git_branch = g("git_branch")
        self.entrypoint = g("entrypoint")
        self.first_ts = g("first_ts")
        self.latest_ts = g("latest_ts")
        self.prev_ts = g("prev_ts")
        self.active_secs = g("active_secs", 0)
        self.continued_in = g("continued_in")
        self.kind = g("kind")

        self.human_turns = g("human_turns", 0)
        self.turn_min = list(g("turn_min", []))
        self.askuser = g("askuser", 0)
        self.tool_calls_total = g("tool_calls_total", 0)
        self.first_ask_turn = g("first_ask_turn")
        self.first_edit_turn = g("first_edit_turn")

        self.fp = dict(g("fp", {}))
        self.fp_text = g("fp_text")

        self.interrupts = g("interrupts", 0)
        self.interrupts_tool = g("interrupts_tool", 0)
        self.denied_user = g("denied_user", 0)
        self.denied_plan = g("denied_plan", 0)
        self.denied_auto = g("denied_auto", 0)
        self.steering = g("steering", 0)
        self.lex_corrections = g("lex_corrections", 0)
        self.reexplain = g("reexplain", 0)
        self.first_correction_turn = g("first_correction_turn")

        self.shingles = set(g("shingles", []))
        self.by_model = dict(g("by_model", {}))
        self.seen_ids = set(g("seen_ids", []))
        self.cache_resets = g("cache_resets", 0)
        self.prev_cr = g("prev_cr")
        self.ctx_peak = g("ctx_peak", 0)
        self.ctx_final = g("ctx_final", 0)
        self.ctx_series = [tuple(p) for p in g("ctx_series", [])]
        self.peak_model = g("peak_model")
        self.compactions = list(g("compactions", []))
        self.turns_after_compaction = g("turns_after_compaction", 0)
        self.reexplain_after_compaction = g("reexplain_after_compaction", 0)
        self.interrupts_after_compaction = g("interrupts_after_compaction", 0)
        self._post_window = g("_post_window", 0)

        self.tools = dict(g("tools", {}))
        self.tool_err = dict(g("tool_err", {}))
        self.tool_bytes = dict(g("tool_bytes", {}))
        self.pending_tools = dict(g("pending_tools", {}))
        self.pending_cmds = dict(g("pending_cmds", {}))

        self.effort = dict(g("effort", {}))
        self.plan_mode = g("plan_mode", False)
        self.skills = list(g("skills", []))
        self.subagents = dict(g("subagents", {"n": 0, "by_type": {}, "by_model": {}, "tool_calls": 0}))

        self.pr_numbers = list(g("pr_numbers", []))
        self.git_commits = g("git_commits", 0)
        self.tests_run = g("tests_run", 0)

    # ------------------------------------------------------------- feeding

    def feed(self, rec):
        rtype = rec.get("type")
        self._note_meta(rec)
        if rtype == "assistant":
            self._feed_assistant(rec)
        elif rtype == "user":
            self._feed_user(rec)
        elif rtype == "system":
            if rec.get("subtype") == "compact_boundary":
                self._feed_compaction(rec)
        elif rtype == "attachment":
            att = rec.get("attachment") or {}
            if att.get("type") == "queued_command":
                self.steering += 1
                self._mark_correction()
        elif rtype == "pr-link":
            n = rec.get("prNumber")
            if n is not None and n not in self.pr_numbers:
                self.pr_numbers.append(n)
        elif rtype == "continued-in":
            self.continued_in = rec.get("continuedInSessionId")

    def _note_meta(self, rec):
        if self.sid is None and rec.get("sessionId"):
            self.sid = rec["sessionId"]
        if rec.get("cwd"):
            self.cwd = rec["cwd"]
        if rec.get("gitBranch"):
            self.git_branch = rec["gitBranch"]
        if rec.get("entrypoint"):
            self.entrypoint = rec["entrypoint"]
        if rec.get("permissionMode") == "plan":
            self.plan_mode = True
        ts = rec.get("timestamp")
        if not ts:
            return
        if self.first_ts is None or ts < self.first_ts:
            self.first_ts = ts
        if self.latest_ts is None or ts > self.latest_ts:
            self.latest_ts = ts
        prev, cur = parse_ts(self.prev_ts), parse_ts(ts)
        if prev and cur:
            gap = (cur - prev).total_seconds()
            if 0 < gap <= ACTIVE_GAP_SECS:
                self.active_secs += gap
        self.prev_ts = ts

    def _minutes_in(self):
        a, b = parse_ts(self.first_ts), parse_ts(self.latest_ts)
        if not a or not b:
            return 0.0
        return round((b - a).total_seconds() / 60.0, 2)

    def _mark_correction(self):
        """Remember how deep into the session the first pushback appeared."""
        turn = max(1, self.human_turns)
        if self.first_correction_turn is None or turn < self.first_correction_turn:
            self.first_correction_turn = turn

    def _feed_assistant(self, rec):
        msg = rec.get("message") or {}
        mid = msg.get("id")
        fresh = True
        if mid:
            if mid in self.seen_ids:
                fresh = False        # a replayed record: billed once, counted once
            else:
                self.seen_ids.add(mid)
        eff = rec.get("effort")
        if eff:
            self.effort[eff] = self.effort.get(eff, 0) + 1
        skill = rec.get("attributionSkill")
        if skill and skill not in self.skills:
            self.skills.append(skill)

        if fresh:
            _add_usage(self.by_model, msg)
            usage = msg.get("usage") or {}
            ctx = call_context(usage)
            if ctx:
                if ctx > self.ctx_peak:
                    self.ctx_peak = ctx
                    self.peak_model = msg.get("model")
                self.ctx_final = ctx
                self.ctx_series.append((self._minutes_in(), ctx))
                cr = usage.get("cache_read_input_tokens") or 0
                if self.prev_cr and cr < self.prev_cr * 0.5:
                    self.cache_resets += 1
                self.prev_cr = cr

        for b in msg.get("content") or []:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            name = b.get("name") or "unknown"
            self.tool_calls_total += 1
            self.tools[name] = self.tools.get(name, 0) + 1
            tid = b.get("id")
            if tid:
                self.pending_tools[tid] = name
            inp = b.get("input") or {}
            if name == "AskUserQuestion":
                self.askuser += 1
                if self.first_ask_turn is None:
                    self.first_ask_turn = max(1, self.human_turns)
            elif name in EDIT_TOOLS and self.first_edit_turn is None:
                self.first_edit_turn = max(1, self.human_turns)
            elif name in ("ExitPlanMode", "EnterPlanMode"):
                self.plan_mode = True
            elif name == "Skill":
                sk = inp.get("skill")
                if sk and sk not in self.skills:
                    self.skills.append(sk)
            elif name == "Bash" and tid:
                cmd = inp.get("command")
                if isinstance(cmd, str):
                    self.pending_cmds[tid] = cmd[:400]

    def _feed_user(self, rec):
        msg = rec.get("message") or {}
        content = msg.get("content")
        text = _text_of(content)

        denial = rec.get("toolDenialKind")
        if denial:
            if denial == "user-rejected":
                self.denied_user += 1
                self._mark_correction()
            elif denial == "permission-rule":
                if "User chose to stay in plan mode and continue planning" in _result_text(content):
                    self.denied_plan += 1
                    self._mark_correction()
                else:
                    self.denied_auto += 1
            else:
                self.denied_auto += 1

        if _has_tool_result(content):
            self._feed_tool_results(content)
            return

        if text.lstrip().startswith(INTERRUPT_PREFIX):
            self.interrupts += 1
            if "for tool use" in text[:80]:
                self.interrupts_tool += 1
            if self._post_window > 0:
                self.interrupts_after_compaction += 1
            self._mark_correction()
            return

        if not is_human_turn(rec):
            return

        self.human_turns += 1
        self.turn_min.append(self._minutes_in())
        if self.human_turns == 1:
            self.fp = first_prompt_features(text)
            self.fp_text = text[:EXCERPT_CHARS * 3]
            if text.lstrip().lower().startswith("/judge-sessions"):
                self.kind = "judge"

        head = text.strip()[:EXCERPT_CHARS]
        if self.human_turns > 1 and LEX_CORRECTION.match(head) and not LEX_NOT_CORRECTION.match(head):
            self.lex_corrections += 1
            self._mark_correction()

        sh = shingles(text)
        repeat = bool(sh & self.shingles) if self.human_turns > 1 else False
        if repeat:
            self.reexplain += 1
            if self._post_window > 0:
                self.reexplain_after_compaction += 1
        if len(self.shingles) < MAX_SHINGLES:
            self.shingles |= sh

        if self._post_window > 0:
            self.turns_after_compaction += 1
            self._post_window -= 1

    def _feed_tool_results(self, content):
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_result":
                continue
            tid = b.get("tool_use_id")
            name = self.pending_tools.pop(tid, "unknown") if tid else "unknown"
            body = b.get("content")
            body_s = body if isinstance(body, str) else json.dumps(body, default=str)
            self.tool_bytes[name] = self.tool_bytes.get(name, 0) + len(body_s or "")
            errored = bool(b.get("is_error"))
            if errored:
                self.tool_err[name] = self.tool_err.get(name, 0) + 1
            cmd = self.pending_cmds.pop(tid, None) if tid else None
            if cmd and not errored:
                if RE_TEST_CMD.search(cmd):
                    self.tests_run += 1
                if RE_COMMIT_CMD.search(cmd):
                    self.git_commits += 1

    def _feed_compaction(self, rec):
        meta = rec.get("compactMetadata") or {}
        pre = meta.get("preTokens")
        entry = {
            "trigger": meta.get("trigger") or "auto",
            "pre": pre,
            "post": meta.get("postTokens"),
            "dropped": meta.get("cumulativeDroppedTokens"),
            "at_min": self._minutes_in(),
            "turn_index": self.human_turns,
        }
        # A duplicate boundary (same dropped total, same pre) is a retry, not an event.
        if self.compactions:
            last = self.compactions[-1]
            if last.get("dropped") == entry["dropped"] and last.get("pre") == entry["pre"]:
                return
        self.compactions.append(entry)
        self._post_window = 5

    # ------------------------------------------------------- serialisation

    def state(self):
        return {
            "sid": self.sid, "cwd": self.cwd, "git_branch": self.git_branch,
            "entrypoint": self.entrypoint, "first_ts": self.first_ts,
            "latest_ts": self.latest_ts, "prev_ts": self.prev_ts,
            "active_secs": self.active_secs, "continued_in": self.continued_in,
            "kind": self.kind,
            "human_turns": self.human_turns, "turn_min": self.turn_min,
            "askuser": self.askuser, "tool_calls_total": self.tool_calls_total,
            "first_ask_turn": self.first_ask_turn, "first_edit_turn": self.first_edit_turn,
            "fp": self.fp, "fp_text": self.fp_text,
            "interrupts": self.interrupts, "interrupts_tool": self.interrupts_tool,
            "denied_user": self.denied_user, "denied_plan": self.denied_plan,
            "denied_auto": self.denied_auto, "steering": self.steering,
            "lex_corrections": self.lex_corrections, "reexplain": self.reexplain,
            "first_correction_turn": self.first_correction_turn,
            "shingles": sorted(self.shingles),
            "by_model": self.by_model, "seen_ids": sorted(self.seen_ids),
            "cache_resets": self.cache_resets, "prev_cr": self.prev_cr,
            "ctx_peak": self.ctx_peak, "ctx_final": self.ctx_final,
            "ctx_series": [list(p) for p in self.ctx_series],
            "peak_model": self.peak_model, "compactions": self.compactions,
            "turns_after_compaction": self.turns_after_compaction,
            "reexplain_after_compaction": self.reexplain_after_compaction,
            "interrupts_after_compaction": self.interrupts_after_compaction,
            "_post_window": self._post_window,
            "tools": self.tools, "tool_err": self.tool_err,
            "tool_bytes": self.tool_bytes, "pending_tools": self.pending_tools,
            "pending_cmds": self.pending_cmds,
            "effort": self.effort, "plan_mode": self.plan_mode, "skills": self.skills,
            "subagents": self.subagents,
            "pr_numbers": self.pr_numbers, "git_commits": self.git_commits,
            "tests_run": self.tests_run,
        }

    def add_subagent(self, sub_state):
        s = self.subagents
        s["n"] = s.get("n", 0) + 1
        t = sub_state.get("agent_type") or "unknown"
        s.setdefault("by_type", {})
        s["by_type"][t] = s["by_type"].get(t, 0) + 1
        s.setdefault("by_model", {})
        for model, b in (sub_state.get("by_model") or {}).items():
            dst = s["by_model"].setdefault(
                model, {"calls": 0, "in": 0, "cc5": 0, "cc1h": 0, "cr": 0, "out": 0, "think": 0, "fast_calls": 0})
            for k, v in b.items():
                dst[k] = dst.get(k, 0) + v
        s["tool_calls"] = s.get("tool_calls", 0) + (sub_state.get("tool_calls") or 0)

    # ------------------------------------------------------------ finalize

    def finalize(self, scrub=None, publish_excerpt=False):
        """The published record. Only ever includes text when explicitly asked."""
        rec = {
            "sid": self.sid,
            "cwd": self.cwd,
            "started_ts": self.first_ts,
            "latest_ts": self.latest_ts,
            "entrypoint": self.entrypoint,
            "human_turns": self.human_turns,
            "askuser": self.askuser,
            "tool_calls_total": self.tool_calls_total,
            "turn_min": [round(m, 2) for m in self.turn_min[:200]],
            "first_ask_turn": self.first_ask_turn,
            "first_edit_turn": self.first_edit_turn,
            "interrupts": self.interrupts,
            "interrupts_tool": self.interrupts_tool,
            "denied_user": self.denied_user,
            "denied_plan": self.denied_plan,
            "denied_auto": self.denied_auto,
            "steering": self.steering,
            "lex_corrections": self.lex_corrections,
            "reexplain": self.reexplain,
            "reexplain_after_compaction": self.reexplain_after_compaction,
            "interrupts_after_compaction": self.interrupts_after_compaction,
            "turns_after_compaction": self.turns_after_compaction,
            "first_correction_turn": self.first_correction_turn,
            "by_model": self.by_model,
            "cache_resets": self.cache_resets,
            "ctx_peak": self.ctx_peak,
            "ctx_final": self.ctx_final,
            "ctx_series": [[round(m, 2), c] for m, c in downsample(self.ctx_series)],
            "ctx_window": model_window(self.peak_model),
            "peak_model": self.peak_model,
            "compactions": self.compactions,
            "tools": self.tools,
            "tool_err": self.tool_err,
            "tool_bytes": self.tool_bytes,
            "effort": self.effort,
            "plan_mode": bool(self.plan_mode),
            "skills": self.skills,
            "subagents": self.subagents,
            "pr_numbers": self.pr_numbers,
            "git_commits": self.git_commits,
            "tests_run": self.tests_run,
            "active_min": round(self.active_secs / 60.0, 1),
            "wall_min": self._minutes_in(),
            "continued_in": self.continued_in,
        }
        if self.kind:
            rec["kind"] = self.kind
        rec.update(self.fp)
        if publish_excerpt and self.fp_text:
            text = " ".join(self.fp_text.split())[:EXCERPT_CHARS]
            rec["fp_excerpt"] = scrub(text) if scrub else text
        return rec


def _result_text(content):
    """Flatten tool_result payloads so a denial reason can be matched."""
    if not isinstance(content, list):
        return ""
    parts = []
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_result":
            continue
        body = b.get("content")
        if isinstance(body, str):
            parts.append(body)
        elif isinstance(body, list):
            for sub in body:
                if isinstance(sub, dict) and isinstance(sub.get("text"), str):
                    parts.append(sub["text"])
    return "\n".join(parts)
