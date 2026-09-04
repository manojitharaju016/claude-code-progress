// Worker unit tests: node --test tests/
// These cover the merge across machines, which is where a stale machine or a
// bad feed would otherwise corrupt everyone's view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMetrics, scrubMetrics, mergeFeeds, emptyTree } from "../src/worker.js";

const feed = (over = {}) => ({
  schema_version: 1, reader_version: "2.0.0", machine: "mac",
  generated_utc: "2026-09-05T10:00:00Z", window_days: 365,
  sessions: [{ sid: "a", latest_ts: "2026-09-05T09:00:00Z" }],
  lifetime: { sessions: 1, by_model: { "claude-opus-5": { calls: 10, out: 100 } } },
  judged: 1, judge_tokens: 500, coach: null, ...over,
});

test("sessions from every machine are tagged and ordered newest first", () => {
  const out = mergeMetrics([
    feed(),
    feed({ machine: "skynet", sessions: [{ sid: "b", latest_ts: "2026-09-05T11:00:00Z" }] }),
  ]);
  assert.deepEqual(out.sessions.map((s) => s.sid), ["b", "a"]);
  assert.deepEqual(out.sessions.map((s) => s.machine), ["skynet", "mac"]);
  assert.equal(out.machines.length, 2);
});

test("a machine with no metrics.json yet is simply absent", () => {
  const out = mergeMetrics([feed(), null]);
  assert.equal(out.machines.length, 1);
  assert.equal(out.sessions.length, 1);
});

test("a feed from an unknown schema is named, not merged", () => {
  const out = mergeMetrics([feed(), feed({ machine: "old", schema_version: 99 })]);
  assert.equal(out.sessions.length, 1, "its sessions are not mixed in");
  assert.deepEqual(out.skipped, [{ name: "old", schema_version: 99, reader_version: "2.0.0" }]);
});

test("no feeds at all is an empty view, not a crash", () => {
  const out = mergeMetrics([]);
  assert.deepEqual(out.sessions, []);
  assert.equal(out.generated_utc, null);
  assert.equal(out.lifetime.sessions, 0);
});

test("lifetime totals and judge cost add up across machines", () => {
  const out = mergeMetrics([feed(), feed({ machine: "cn" })]);
  assert.equal(out.lifetime.sessions, 2);
  assert.equal(out.lifetime.by_model["claude-opus-5"].calls, 20);
  assert.equal(out.judged, 2);
  assert.equal(out.judge_tokens, 1000);
});

test("generated_utc is the newest machine's, not the last one seen", () => {
  const out = mergeMetrics([
    feed({ generated_utc: "2026-09-05T10:00:00Z" }),
    feed({ machine: "cn", generated_utc: "2026-09-04T10:00:00Z" }),
  ]);
  assert.equal(out.generated_utc, "2026-09-05T10:00:00Z");
});

test("the newest coach note wins and says which machine wrote it", () => {
  const out = mergeMetrics([
    feed({ coach: { date: "2026-09-01", notes: [] } }),
    feed({ machine: "cn", coach: { date: "2026-09-04", notes: [] } }),
  ]);
  assert.equal(out.coach.date, "2026-09-04");
  assert.equal(out.coach.machine, "cn");
});

test("free-text fields are re-scrubbed, numbers are left alone", () => {
  const tree = {
    sessions: [{ sid: "a", fp_excerpt: "use sk-ant-abcdefghijklmnopqrst now", ctx_peak: 999,
                 j: { summary: "token ghp_abcdefghijklmnopqrstu leaked" } }],
    coach: { notes: [{ pattern: "key AKIA0123456789ABCDEF", advice: "fine", prompt_shape: "fine" }] },
  };
  scrubMetrics(tree);
  const s = tree.sessions[0];
  assert.ok(!s.fp_excerpt.includes("sk-ant-"));
  assert.ok(!s.j.summary.includes("ghp_"));
  assert.ok(!tree.coach.notes[0].pattern.includes("AKIA0123456789ABCDEF"));
  assert.equal(s.ctx_peak, 999, "numbers untouched");
});

test("scrubbing a feed with no optional fields does not throw", () => {
  const tree = { sessions: [{ sid: "a" }], coach: null };
  scrubMetrics(tree);
  assert.equal(tree.sessions[0].sid, "a");
});

test("the progress feed still merges as before", () => {
  const t = mergeFeeds([{ schema_version: 1, machine: "mac", generated_utc: "2026-09-05T10:00:00Z",
                          projects: [{ key: "mac::/w", stages: [] }], counts: {}, foreground: {} }]);
  assert.equal(t.projects.length, 1);
  assert.equal(emptyTree().projects.length, 0);
});
