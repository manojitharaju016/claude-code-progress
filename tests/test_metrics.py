#!/usr/bin/env python3
"""
Unit tests for agent/metrics.py.

Every fixture here is synthetic. No real transcript is read, so the suite runs
anywhere and never touches private data. Run with:

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent"))

import metrics  # noqa: E402


T0 = "2026-09-01T10:00:00.000Z"


def ts(minute, second=0):
    return "2026-09-01T%02d:%02d:%02d.000Z" % (10 + minute // 60, minute % 60, second)


def human(text, when=T0, **kw):
    rec = {"type": "user", "timestamp": when, "sessionId": "s1", "cwd": "/w/proj",
           "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
    rec.update(kw)
    return rec


def assistant(mid, usage=None, blocks=None, model="claude-opus-5", when=T0, **kw):
    rec = {"type": "assistant", "timestamp": when, "sessionId": "s1", "cwd": "/w/proj",
           "message": {"id": mid, "model": model, "content": blocks or [],
                       "usage": usage or {}}}
    rec.update(kw)
    return rec


def usage(inp=10, cc5=0, cc1h=0, cr=0, out=100, think=0, speed=None):
    u = {"input_tokens": inp, "cache_read_input_tokens": cr, "output_tokens": out,
         "cache_creation_input_tokens": cc5 + cc1h,
         "cache_creation": {"ephemeral_5m_input_tokens": cc5, "ephemeral_1h_input_tokens": cc1h},
         "output_tokens_details": {"thinking_tokens": think}}
    if speed:
        u["speed"] = speed
    return u


def tool_use(tid, name, inp=None):
    return {"type": "tool_use", "id": tid, "name": name, "input": inp or {}}


def tool_result(tid, body="ok", is_error=False, when=T0):
    return {"type": "user", "timestamp": when, "sessionId": "s1",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tid, "content": body, "is_error": is_error}]}}


def run(records, **kw):
    acc = metrics.SessionAccumulator()
    for r in records:
        acc.feed(r)
    return acc.finalize(**kw)


class HumanTurnFilter(unittest.TestCase):
    """Only messages the person typed count as turns. Each exclusion is a fact."""

    def test_plain_message_counts(self):
        self.assertTrue(metrics.is_human_turn(human("do the thing")))

    def test_tool_result_is_not_a_turn(self):
        self.assertFalse(metrics.is_human_turn(tool_result("t1")))

    def test_meta_flag_excluded(self):
        self.assertFalse(metrics.is_human_turn(human("caveat text", isMeta=True)))

    def test_compact_summary_excluded(self):
        self.assertFalse(metrics.is_human_turn(human("continued from", isCompactSummary=True)))

    def test_interrupt_text_is_not_a_turn(self):
        self.assertFalse(metrics.is_human_turn(human("[Request interrupted by user]")))

    def test_slash_command_plumbing_excluded(self):
        self.assertFalse(metrics.is_human_turn(human("<command-name>loop</command-name>")))

    def test_task_notification_excluded(self):
        self.assertFalse(metrics.is_human_turn(human("<task-notification>done</task-notification>")))

    def test_non_human_origin_excluded(self):
        self.assertFalse(metrics.is_human_turn(human("x", origin={"kind": "task-notification"})))

    def test_sidechain_excluded(self):
        self.assertFalse(metrics.is_human_turn(human("subagent prompt", isSidechain=True)))

    def test_string_content_supported(self):
        rec = {"type": "user", "message": {"role": "user", "content": "plain string prompt"}}
        self.assertTrue(metrics.is_human_turn(rec))


class TokenAccounting(unittest.TestCase):
    """One API message is many JSONL records; usage must be counted once."""

    def test_split_records_are_deduped(self):
        u = usage(inp=5, cc5=100, cr=900, out=50)
        out = run([assistant("m1", u, [{"type": "thinking", "thinking": ""}]),
                   assistant("m1", u, [{"type": "text", "text": "hi"}]),
                   assistant("m1", u, [tool_use("t1", "Read")])])
        b = out["by_model"]["claude-opus-5"]
        self.assertEqual(b["calls"], 1)
        self.assertEqual(b["out"], 50)
        self.assertEqual(out["tool_calls_total"], 1, "tool calls still counted on every record")

    def test_replayed_message_far_later_is_not_recounted(self):
        """After a compaction the preserved segment is rewritten into the file,
        so the same message.id can reappear hundreds of records later."""
        u = usage(inp=5, cc5=100, cr=900, out=50)
        recs = [assistant("m1", u, [{"type": "text", "text": "first"}])]
        for i in range(50):
            recs.append(assistant("filler%d" % i, usage(out=1), []))
        recs.append(assistant("m1", u, [{"type": "text", "text": "first"}]))
        out = run(recs)
        b = out["by_model"]["claude-opus-5"]
        self.assertEqual(b["calls"], 51, "51 distinct messages, not 52")
        self.assertEqual(b["out"], 50 + 50)

    def test_context_is_input_plus_both_caches(self):
        out = run([assistant("m1", usage(inp=5, cc5=100, cc1h=200, cr=900))])
        self.assertEqual(out["ctx_peak"], 1205)

    def test_thinking_is_not_added_to_output(self):
        out = run([assistant("m1", usage(out=500, think=300))])
        b = out["by_model"]["claude-opus-5"]
        self.assertEqual(b["out"], 500)
        self.assertEqual(b["think"], 300)

    def test_fast_calls_counted(self):
        out = run([assistant("m1", usage(speed="fast"))])
        self.assertEqual(out["by_model"]["claude-opus-5"]["fast_calls"], 1)

    def test_cache_reset_detected_on_halving(self):
        out = run([assistant("m1", usage(cr=100000)),
                   assistant("m2", usage(cr=110000)),
                   assistant("m3", usage(cr=2000))])
        self.assertEqual(out["cache_resets"], 1)

    def test_window_defaults_and_haiku(self):
        self.assertEqual(metrics.model_window("claude-opus-5"), 1000000)
        self.assertEqual(metrics.model_window("claude-haiku-4-5-20251001"), 200000)
        self.assertEqual(metrics.model_window(None), 1000000)

    def test_peak_model_tracks_the_peak(self):
        out = run([assistant("m1", usage(cr=500), model="claude-haiku-4-5"),
                   assistant("m2", usage(cr=9000), model="claude-opus-5")])
        self.assertEqual(out["peak_model"], "claude-opus-5")
        self.assertEqual(out["ctx_window"], 1000000)


class HardSignals(unittest.TestCase):
    """Revisions the harness itself recorded."""

    def test_interrupt_counted_and_typed(self):
        out = run([human("go"), human("[Request interrupted by user for tool use]")])
        self.assertEqual(out["interrupts"], 1)
        self.assertEqual(out["interrupts_tool"], 1)
        self.assertEqual(out["human_turns"], 1, "an interrupt is not a typed turn")

    def test_user_rejected_tool(self):
        rec = tool_result("t1", "The user doesn't want to proceed with this tool use.", is_error=True)
        rec["toolDenialKind"] = "user-rejected"
        out = run([human("go"), rec])
        self.assertEqual(out["denied_user"], 1)

    def test_plan_rejection_needs_the_exact_text(self):
        plan = tool_result("t1", "User chose to stay in plan mode and continue planning\n\nComments: no", is_error=True)
        plan["toolDenialKind"] = "permission-rule"
        out = run([human("go"), plan])
        self.assertEqual(out["denied_plan"], 1)
        self.assertEqual(out["denied_auto"], 0)

    def test_ordinary_permission_rule_is_not_a_plan_rejection(self):
        rec = tool_result("t1", "Permission to use Bash with command rm", is_error=True)
        rec["toolDenialKind"] = "permission-rule"
        out = run([human("go"), rec])
        self.assertEqual(out["denied_plan"], 0)
        self.assertEqual(out["denied_auto"], 1)

    def test_automode_denials_are_environment_not_revisions(self):
        for kind in ("automode-blocked", "automode-unavailable"):
            rec = tool_result("t1", "blocked", is_error=True)
            rec["toolDenialKind"] = kind
            out = run([human("go"), rec])
            self.assertEqual(out["denied_auto"], 1)
            self.assertEqual(out["denied_user"], 0)

    def test_steering_is_the_queued_command_attachment(self):
        out = run([human("go"),
                   {"type": "attachment", "timestamp": T0, "attachment": {"type": "queued_command"}},
                   {"type": "attachment", "timestamp": T0, "attachment": {"type": "todo_reminder"}}])
        self.assertEqual(out["steering"], 1)

    def test_first_correction_turn_records_depth(self):
        out = run([human("one", ts(0)), human("two", ts(1)), human("[Request interrupted by user]", ts(2))])
        self.assertEqual(out["first_correction_turn"], 2)


class LexiconAndRepeats(unittest.TestCase):
    """Guesses, clearly bounded."""

    def test_correction_lexicon_hits(self):
        out = run([human("build it"), human("no, that is wrong")])
        self.assertEqual(out["lex_corrections"], 1)

    def test_no_worries_is_not_a_correction(self):
        out = run([human("build it"), human("no worries, carry on")])
        self.assertEqual(out["lex_corrections"], 0)

    def test_first_turn_is_never_a_correction(self):
        out = run([human("no, do it this way")])
        self.assertEqual(out["lex_corrections"], 0)

    def test_repeated_wording_detected(self):
        line = "the parser must keep the original column order intact"
        out = run([human(line), human("please remember " + line)])
        self.assertEqual(out["reexplain"], 1)

    def test_short_turns_do_not_trigger_repeats(self):
        out = run([human("ok"), human("ok")])
        self.assertEqual(out["reexplain"], 0)


class Compaction(unittest.TestCase):
    def _boundary(self, pre, post, dropped=1000, when=T0):
        return {"type": "system", "subtype": "compact_boundary", "timestamp": when,
                "compactMetadata": {"trigger": "auto", "preTokens": pre,
                                    "postTokens": post, "cumulativeDroppedTokens": dropped}}

    def test_boundary_recorded_with_context(self):
        out = run([human("go"), self._boundary(900000, 30000)])
        self.assertEqual(len(out["compactions"]), 1)
        c = out["compactions"][0]
        self.assertEqual((c["pre"], c["post"], c["trigger"]), (900000, 30000, "auto"))

    def test_duplicate_boundary_ignored(self):
        b = self._boundary(900000, 30000, dropped=5)
        out = run([human("go"), b, dict(b)])
        self.assertEqual(len(out["compactions"]), 1)

    def test_post_compaction_window_counts_five_turns(self):
        recs = [human("start with a long distinctive sentence about parsers", ts(0)),
                self._boundary(900000, 30000, when=ts(1))]
        for i in range(7):
            recs.append(human("follow up number %d here" % i, ts(2 + i)))
        out = run(recs)
        self.assertEqual(out["turns_after_compaction"], 5)

    def test_repeat_after_compaction_attributed(self):
        line = "keep the original column order intact in every exported file"
        out = run([human(line, ts(0)),
                   self._boundary(900000, 30000, when=ts(1)),
                   human("as I said, " + line, ts(2))])
        self.assertEqual(out["reexplain"], 1)
        self.assertEqual(out["reexplain_after_compaction"], 1)


class ToolsAndOutcomes(unittest.TestCase):
    def test_tool_bytes_attributed_by_id(self):
        out = run([assistant("m1", usage(), [tool_use("t1", "Read")]),
                   tool_result("t1", "x" * 500)])
        self.assertEqual(out["tool_bytes"]["Read"], 500)
        self.assertEqual(out["tools"]["Read"], 1)

    def test_tool_errors_counted(self):
        out = run([assistant("m1", usage(), [tool_use("t1", "Bash")]),
                   tool_result("t1", "boom", is_error=True)])
        self.assertEqual(out["tool_err"]["Bash"], 1)

    def test_tests_and_commits_need_a_clean_result(self):
        out = run([assistant("m1", usage(), [tool_use("t1", "Bash", {"command": "pytest -q"})]),
                   tool_result("t1", "5 passed"),
                   assistant("m2", usage(), [tool_use("t2", "Bash", {"command": "git commit -m x"})]),
                   tool_result("t2", "nothing to commit", is_error=True)])
        self.assertEqual(out["tests_run"], 1)
        self.assertEqual(out["git_commits"], 0, "an errored command did not commit")

    def test_askuser_and_edit_turn_indices(self):
        out = run([human("go", ts(0)),
                   assistant("m1", usage(), [tool_use("t1", "AskUserQuestion")]),
                   human("answer", ts(1)),
                   assistant("m2", usage(), [tool_use("t2", "Edit")])])
        self.assertEqual(out["askuser"], 1)
        self.assertEqual(out["first_ask_turn"], 1)
        self.assertEqual(out["first_edit_turn"], 2)
        self.assertLess(out["first_ask_turn"], out["first_edit_turn"], "asked before editing")

    def test_plan_mode_from_tool_or_permission(self):
        self.assertTrue(run([assistant("m1", usage(), [tool_use("t1", "ExitPlanMode")])])["plan_mode"])
        self.assertTrue(run([human("go", permissionMode="plan")])["plan_mode"])

    def test_skills_from_tool_and_attribution(self):
        out = run([assistant("m1", usage(), [tool_use("t1", "Skill", {"skill": "dataviz"})]),
                   assistant("m2", usage(), [], attributionSkill="run")])
        self.assertEqual(sorted(out["skills"]), ["dataviz", "run"])

    def test_pr_links_collected_once(self):
        out = run([{"type": "pr-link", "prNumber": 57}, {"type": "pr-link", "prNumber": 57}])
        self.assertEqual(out["pr_numbers"], [57])

    def test_continued_in_recorded(self):
        out = run([{"type": "continued-in", "continuedInSessionId": "s2"}])
        self.assertEqual(out["continued_in"], "s2")


class TimeAndSeries(unittest.TestCase):
    def test_active_minutes_ignore_long_gaps(self):
        out = run([human("a", ts(0)), human("b", ts(5)), human("c", ts(300))])
        self.assertEqual(out["active_min"], 5.0)
        self.assertGreater(out["wall_min"], 290)

    def test_turn_minutes_are_real_not_interpolated(self):
        out = run([human("a", ts(0)), human("b", ts(7))])
        self.assertEqual(out["turn_min"], [0.0, 7.0])

    def test_downsample_keeps_ends_and_peak(self):
        pts = [(float(i), i * 10) for i in range(200)]
        pts[57] = (57.0, 99999)
        got = metrics.downsample(pts)
        self.assertLessEqual(len(got), metrics.MAX_CTX_POINTS)
        self.assertEqual(got[0], pts[0])
        self.assertEqual(got[-1], pts[-1])
        self.assertIn((57.0, 99999), got)

    def test_z_suffix_parses_on_python_39(self):
        self.assertIsNotNone(metrics.parse_ts("2026-09-01T10:00:00.000Z"))
        self.assertIsNone(metrics.parse_ts("not a date"))


class FirstPromptAndPrivacy(unittest.TestCase):
    def test_flags_detected(self):
        f = metrics.first_prompt_features("In src/app.py, fix the loop. Do not touch tests. Done when pytest passes.")
        self.assertTrue(f["has_path"] and f["has_constraint"] and f["has_done_criterion"])
        self.assertFalse(f["is_question"])

    def test_question_detected_two_ways(self):
        self.assertTrue(metrics.first_prompt_features("Why does this fail?")["is_question"])
        self.assertTrue(metrics.first_prompt_features("How do I run it")["is_question"])

    def test_no_excerpt_unless_requested(self):
        out = run([human("a secret sounding opening prompt")])
        self.assertNotIn("fp_excerpt", out)

    def test_excerpt_is_scrubbed_and_capped(self):
        long_text = "token sk-ant-secret " + ("word " * 200)
        out = run([human(long_text)], publish_excerpt=True,
                  scrub=lambda t: t.replace("sk-ant-secret", "<redacted>"))
        self.assertIn("<redacted>", out["fp_excerpt"])
        self.assertNotIn("sk-ant-secret", out["fp_excerpt"])
        self.assertLessEqual(len(out["fp_excerpt"]), metrics.EXCERPT_CHARS)

    def test_judge_sessions_are_tagged_so_they_never_measure_themselves(self):
        out = run([human("/judge-sessions")])
        self.assertEqual(out.get("kind"), "judge")

    def test_ordinary_session_has_no_kind(self):
        self.assertIsNone(run([human("do the work")]).get("kind"))


class IncrementalResume(unittest.TestCase):
    """A growing transcript must fold to exactly what a full scan produces."""

    def _records(self):
        line = "the exporter must keep the original column order intact"
        return [
            human(line, ts(0)),
            assistant("m1", usage(inp=5, cc5=1000, cr=2000), [tool_use("t1", "Read")], when=ts(1)),
            tool_result("t1", "y" * 300, when=ts(2)),
            human("no, that is wrong", ts(3)),
            assistant("m2", usage(inp=5, cc5=10, cr=3000), [tool_use("t2", "Bash", {"command": "pytest"})], when=ts(4)),
            tool_result("t2", "1 passed", when=ts(5)),
            human("also " + line, ts(6)),
        ]

    def test_resume_equals_full_scan_at_every_split(self):
        recs = self._records()
        full = run(recs)
        for split in range(1, len(recs)):
            acc = metrics.SessionAccumulator()
            for r in recs[:split]:
                acc.feed(r)
            carried = json.loads(json.dumps(acc.state()))   # survives the cache round-trip
            acc2 = metrics.SessionAccumulator(carried)
            for r in recs[split:]:
                acc2.feed(r)
            self.assertEqual(acc2.finalize(), full, "resume differed when split at %d" % split)

    def test_split_message_across_the_resume_boundary_is_not_double_counted(self):
        u = usage(inp=5, cc5=100, cr=900, out=50)
        acc = metrics.SessionAccumulator()
        acc.feed(assistant("m1", u, [{"type": "thinking", "thinking": ""}]))
        acc2 = metrics.SessionAccumulator(json.loads(json.dumps(acc.state())))
        acc2.feed(assistant("m1", u, [{"type": "text", "text": "hi"}]))
        self.assertEqual(acc2.finalize()["by_model"]["claude-opus-5"]["calls"], 1)

    def test_pending_tool_map_survives_the_boundary(self):
        acc = metrics.SessionAccumulator()
        acc.feed(assistant("m1", usage(), [tool_use("t1", "Grep")]))
        acc2 = metrics.SessionAccumulator(json.loads(json.dumps(acc.state())))
        acc2.feed(tool_result("t1", "z" * 42))
        self.assertEqual(acc2.finalize()["tool_bytes"]["Grep"], 42)

    def test_state_is_json_serialisable(self):
        acc = metrics.SessionAccumulator()
        for r in self._records():
            acc.feed(r)
        json.dumps(acc.state())


class Subagents(unittest.TestCase):
    def test_rollup_sums_tokens_and_types(self):
        sub = metrics.SubagentAccumulator({"agent_type": "Explore"})
        sub.feed(assistant("s1", usage(out=10), [tool_use("x", "Read")]))
        sub.feed(assistant("s1", usage(out=10), [{"type": "text", "text": "done"}]))
        acc = metrics.SessionAccumulator()
        acc.add_subagent(sub.state())
        acc.add_subagent(sub.state())
        out = acc.finalize()
        self.assertEqual(out["subagents"]["n"], 2)
        self.assertEqual(out["subagents"]["by_type"]["Explore"], 2)
        self.assertEqual(out["subagents"]["by_model"]["claude-opus-5"]["out"], 20)


if __name__ == "__main__":
    unittest.main()
