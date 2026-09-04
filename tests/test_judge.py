#!/usr/bin/env python3
"""
Unit tests for agent/judge.py.

The validator is the only thing standing between a model's free text and the
dashboard, so every rule it enforces is pinned here. No network, no real
transcripts: digests are built from synthetic JSONL written to a temp file.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

AGENT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent")
sys.path.insert(0, AGENT)

os.environ.setdefault("CC_PROGRESS_CLAUDE_DIR", tempfile.mkdtemp(prefix="ccjudge-"))

import judge  # noqa: E402


def good_result(sid="s1", n=2):
    return {
        "sid": sid,
        "n_turns": n,
        "judged_by": "claude-opus-5",
        "turns": [{"i": 1, "label": "new_task"},
                  {"i": 2, "label": "correction", "cause": "prompt_gap"}],
        "first_prompt": {"goal": True, "context": False, "constraints": False,
                         "done_criterion": False, "scope": False},
        "score": 1,
        "missing": ["current state"],
        "outcome": "partial",
        "summary": "Opening named a goal but no paths, so turns went to locating code.",
    }


def queued(sid="s1", n=2, turns=None):
    return {"sid": sid, "n_turns": n,
            "digest": {"turns": turns or [{"i": 1, "you": "please refactor the exporter"},
                                          {"i": 2, "you": "no, the other one"}]}}


class Validation(unittest.TestCase):
    def test_a_correct_verdict_passes(self):
        self.assertEqual(judge.validate(good_result(), queued()), [])

    def test_sid_must_match(self):
        r = good_result(sid="other")
        self.assertIn("sid does not match the queued session", judge.validate(r, queued()))

    def test_turn_count_must_match(self):
        r = good_result(n=9)
        self.assertTrue(any("n_turns" in p for p in judge.validate(r, queued())))

    def test_unknown_label_rejected(self):
        r = good_result()
        r["turns"][1]["label"] = "grumpy"
        self.assertTrue(any("unknown label" in p for p in judge.validate(r, queued())))

    def test_unknown_cause_rejected(self):
        r = good_result()
        r["turns"][1]["cause"] = "vibes"
        self.assertTrue(any("unknown cause" in p for p in judge.validate(r, queued())))

    def test_every_documented_label_and_cause_is_accepted(self):
        for label in judge.LABELS:
            r = good_result()
            r["turns"][1] = {"i": 2, "label": label}
            self.assertEqual(judge.validate(r, queued()), [], "label %s rejected" % label)
        for cause in judge.CAUSES:
            r = good_result()
            r["turns"][1] = {"i": 2, "label": "correction", "cause": cause}
            self.assertEqual(judge.validate(r, queued()), [], "cause %s rejected" % cause)

    def test_score_must_equal_the_rubric_items(self):
        r = good_result()
        r["score"] = 5
        self.assertTrue(any("does not match" in p for p in judge.validate(r, queued())))

    def test_score_of_five_when_all_true(self):
        r = good_result()
        r["first_prompt"] = {k: True for k in judge.RUBRIC}
        r["score"] = 5
        self.assertEqual(judge.validate(r, queued()), [])

    def test_missing_vocabulary_is_closed(self):
        r = good_result()
        r["missing"] = ["more detail please"]
        self.assertTrue(any("fixed vocabulary" in p for p in judge.validate(r, queued())))

    def test_outcome_vocabulary_is_closed(self):
        r = good_result()
        r["outcome"] = "great"
        self.assertTrue(any("unknown outcome" in p for p in judge.validate(r, queued())))

    def test_summary_length_capped(self):
        r = good_result()
        r["summary"] = "x" * 141
        self.assertTrue(any("140" in p for p in judge.validate(r, queued())))

    def test_summary_quoting_the_user_is_rejected(self):
        """A judgement must describe the pattern, not echo the person's words."""
        line = "please refactor the exporter so column order is preserved exactly"
        r = good_result()
        r["summary"] = "User asked: " + line
        problems = judge.validate(r, queued(turns=[{"i": 1, "you": line}, {"i": 2, "you": "ok"}]))
        self.assertTrue(any("quotes" in p for p in problems))

    def test_paraphrase_is_allowed(self):
        r = good_result()
        r["summary"] = "The opener omitted the acceptance check, so verification came late."
        self.assertEqual(judge.validate(r, queued()), [])

    def test_non_object_rejected(self):
        self.assertEqual(judge.validate("nope", queued()), ["not a JSON object"])

    def test_turn_index_must_be_positive_int(self):
        r = good_result()
        r["turns"][0]["i"] = 0
        self.assertTrue(any("positive integer" in p for p in judge.validate(r, queued())))


class DigestBuilding(unittest.TestCase):
    def _write(self, records):
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(fd, "w") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")
        self.addCleanup(os.remove, path)
        return path

    def _human(self, text, i=0):
        return {"type": "user", "timestamp": "2026-09-01T10:0%d:00.000Z" % i,
                "sessionId": "s1", "message": {"role": "user",
                                               "content": [{"type": "text", "text": text}]}}

    def test_digest_pairs_turns_with_what_claude_did(self):
        path = self._write([
            self._human("do the thing", 0),
            {"type": "assistant", "timestamp": "2026-09-01T10:01:00.000Z",
             "message": {"id": "m1", "model": "claude-opus-5", "usage": {},
                         "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
                                     {"type": "text", "text": "I read the file."}]}},
            self._human("no, the other file", 2),
        ])
        d = judge.build_digest(path, set())
        self.assertEqual(d["human_turns"], 2)
        self.assertEqual([t["i"] for t in d["turns"]], [1, 2])
        self.assertEqual(d["turns"][0]["claude"]["tools"], {"Read": 1})
        self.assertEqual(d["turns"][0]["claude"]["said"], "I read the file.")

    def test_secrets_are_scrubbed_before_the_digest_exists(self):
        path = self._write([self._human("use key sk-ant-abcdefghijklmnop please")])
        d = judge.build_digest(path, set())
        self.assertNotIn("sk-ant-abcdefghijklmnop", d["turns"][0]["you"])

    def test_denyset_values_are_scrubbed(self):
        path = self._write([self._human("the password is hunter2hunter2hunter2")])
        d = judge.build_digest(path, {"hunter2hunter2hunter2"})
        self.assertNotIn("hunter2hunter2hunter2", d["turns"][0]["you"])

    def test_reminder_blocks_are_stripped(self):
        path = self._write([self._human("real ask <system-reminder>ignore me</system-reminder> here")])
        d = judge.build_digest(path, set())
        self.assertNotIn("ignore me", d["turns"][0]["you"])
        self.assertIn("real ask", d["turns"][0]["you"])

    def test_human_text_is_truncated(self):
        path = self._write([self._human("word " * 500)])
        d = judge.build_digest(path, set())
        self.assertLessEqual(len(d["turns"][0]["you"]), judge.HUMAN_CHARS)

    def test_only_the_last_turns_are_kept_and_the_rest_counted(self):
        recs = [self._human("turn %d text" % i, i % 10) for i in range(60)]
        d = judge.build_digest(self._write(recs), set())
        self.assertEqual(len(d["turns"]), judge.MAX_TURNS_IN_DIGEST)
        self.assertEqual(d["omitted_earlier_turns"], 60 - judge.MAX_TURNS_IN_DIGEST)
        self.assertEqual(d["human_turns"], 60)

    def test_flags_record_what_the_harness_saw(self):
        path = self._write([
            self._human("go", 0),
            {"type": "attachment", "timestamp": "2026-09-01T10:01:00.000Z",
             "attachment": {"type": "queued_command"}},
            {"type": "system", "subtype": "compact_boundary",
             "timestamp": "2026-09-01T10:02:00.000Z", "compactMetadata": {"trigger": "auto"}},
            self._human("next", 3),
        ])
        d = judge.build_digest(path, set())
        flags = d["turns"][0]["claude"]["flags"]
        self.assertIn("you sent a message mid-turn", flags)
        self.assertIn("context was compacted here", flags)

    def test_session_with_no_human_turns_yields_nothing(self):
        path = self._write([{"type": "assistant", "message": {"id": "m1", "content": [], "usage": {}}}])
        self.assertIsNone(judge.build_digest(path, set()))


class VocabulariesMatchTheSkill(unittest.TestCase):
    """The skill file documents these lists to the model; drift breaks ingest."""

    def _skill_text(self):
        p = os.path.join(AGENT, "skills", "judge-sessions", "SKILL.md")
        with open(p) as fh:
            return fh.read()

    def test_every_label_cause_missing_and_outcome_is_documented(self):
        text = self._skill_text()
        for name, vocab in (("label", judge.LABELS), ("cause", judge.CAUSES),
                            ("missing", judge.MISSING), ("outcome", judge.OUTCOMES),
                            ("rubric", judge.RUBRIC)):
            for v in vocab:
                self.assertIn(v, text, "%s %r is not documented in SKILL.md" % (name, v))

    def test_skill_documents_the_score_rule_and_the_quoting_rule(self):
        text = self._skill_text()
        self.assertIn("must equal", text)
        self.assertIn("140 characters", text)


if __name__ == "__main__":
    unittest.main()
