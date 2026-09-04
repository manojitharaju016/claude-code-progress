// insights.test.mjs — the statistics policy and every rule's honesty rules.
// node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pooledRate, compare, median, share, runRules, report, compactionVerdict,
  hard, steering, anchors, costOf, priceFor, fmtBytes, noVisibleCorrection,
  MIN_N, MIN_RATE_FOR_RATIO,
} from "../public/insights.js";

const S = (over = {}) => ({
  sid: "s" + Math.random().toString(36).slice(2), human_turns: 10, tool_calls_total: 20,
  interrupts: 0, denied_user: 0, denied_plan: 0, steering: 0, lex_corrections: 0,
  reexplain: 0, compactions: [], by_model: {}, tools: {}, tool_bytes: {},
  ctx_peak: 100000, ctx_window: 1000000, cache_resets: 0, ...over,
});
const many = (n, over) => Array.from({ length: n }, () => S(over));

test("a rate is pooled across the group, not a median of mostly-zero sessions", () => {
  // Nine quiet sessions and one bad one. A median would report 0.
  const g = [...many(9, { interrupts: 0 }), S({ interrupts: 10 })];
  const r = pooledRate(g, hard, (s) => s.human_turns);
  assert.equal(r.events, 10);
  assert.equal(r.turns, 100);
  assert.equal(r.rate, 1, "10 events over 100 turns is 1 per 10 turns");
  assert.equal(median(g.map(hard)), 0, "the median really would have said nothing happened");
});

test("no multiple is quoted when the reference rate is too small to divide by", () => {
  const worse = pooledRate(many(10, { interrupts: 2 }), hard, (s) => s.human_turns);   // 2.0
  const better = pooledRate(many(10, { interrupts: 0.04 }), hard, (s) => s.human_turns); // 0.04
  const c = compare(worse, better);
  assert.ok(better.rate < MIN_RATE_FOR_RATIO);
  assert.equal(c.canRatio, false);
  assert.equal(c.ratio, null);
  assert.match(c.phrase, /per 10 turns$/, "an absolute gap, never an x");
});

test("a multiple is quoted once the reference group has a real rate", () => {
  const worse = pooledRate(many(10, { interrupts: 4 }), hard, (s) => s.human_turns);
  const better = pooledRate(many(10, { interrupts: 1 }), hard, (s) => s.human_turns);
  const c = compare(worse, better);
  assert.equal(c.canRatio, true);
  assert.equal(c.phrase, "4.0x");
});

test("a group below the minimum is never compared", () => {
  const c = compare(pooledRate(many(2, { interrupts: 5 }), hard, (s) => s.human_turns),
                    pooledRate(many(30), hard, (s) => s.human_turns));
  assert.equal(c.enough, false);
});

test("mid-turn steering is kept out of hard revisions", () => {
  const s = S({ interrupts: 1, denied_user: 1, denied_plan: 1, steering: 50 });
  assert.equal(hard(s), 3, "steering does not inflate the revision count");
  assert.equal(steering(s), 50, "but it is still available on its own");
});

test("a session with only steering still counts as having no visible correction", () => {
  assert.equal(noVisibleCorrection(S({ steering: 4 })), true);
  assert.equal(noVisibleCorrection(S({ interrupts: 1 })), false);
  assert.equal(noVisibleCorrection(S({ resumed_from: "x" })), false, "resumed sessions are excluded");
});

test("anchors count the three structural flags", () => {
  assert.equal(anchors(S({ has_path: true, has_constraint: true })), 2);
  assert.equal(anchors(S()), 0);
});

test("the confidence band does not collide with a bucket's own fields", () => {
  const r = pooledRate(many(5, { interrupts: 1 }), hard, (s) => s.human_turns);
  assert.ok("bandLo" in r && "bandHi" in r);
  assert.ok(!("lo" in r), "lo/hi would silently overwrite a caller's own lo/hi");
  const bucket = { label: "16-40 turns", from: 16, ...r };
  assert.equal(bucket.from, 16, "the band did not clobber the band edge");
});

test("a rule fires on a real gap and stays silent on noise", () => {
  const loud = runRules([
    ...many(20, { has_path: false, has_constraint: false, has_done_criterion: false, interrupts: 4 }),
    ...many(20, { has_path: true, has_constraint: true, has_done_criterion: true, interrupts: 1 }),
  ]);
  assert.ok(loud.findings.some((f) => f.id === "first_prompt_anchors"));
  const quiet = runRules(many(40, { has_path: true, has_constraint: true, interrupts: 1 }));
  assert.ok(!quiet.findings.some((f) => f.id === "first_prompt_anchors"));
});

test("every finding carries the fields the card renders", () => {
  const { findings } = runRules([
    ...many(20, { interrupts: 4 }),
    ...many(20, { has_path: true, has_constraint: true, has_done_criterion: true, interrupts: 1 }),
  ]);
  assert.ok(findings.length);
  for (const f of findings) {
    for (const k of ["headline", "chart", "wentWrong", "improve", "promptShape",
                     "howToRead", "confidence", "score", "n"]) {
      assert.ok(f[k] !== undefined && f[k] !== "", `${f.id} is missing ${k}`);
    }
    assert.ok(/associ|correl|not a cause|not proof|judgement/i.test(f.confidence),
      `${f.id} must not imply causation without a caveat`);
    assert.ok(!/\bcaused\b|\bcuts\b|\bproves\b/i.test(f.headline), `${f.id} headline claims cause`);
  }
});

test("judged rules stay locked until there are enough judged sessions", () => {
  const { locked } = runRules(many(30));
  const ids = locked.map((l) => l.id);
  for (const id of ["first_prompt_score", "correction_causes", "missing_ingredient_cost"]) {
    assert.ok(ids.includes(id));
  }
  assert.match(locked.find((l) => l.id === "first_prompt_score").reason, /judged/);
});

test("findings are ranked by effect, reach and sample size together", () => {
  const { findings } = runRules([
    ...many(20, { interrupts: 4 }),
    ...many(20, { has_path: true, has_constraint: true, has_done_criterion: true, interrupts: 1 }),
  ]);
  for (let i = 1; i < findings.length; i++) {
    assert.ok(findings[i - 1].score >= findings[i].score);
  }
});

test("the report never ends in a doubled full stop", () => {
  const sessions = many(20, { interrupts: 2 });
  const { findings, judged } = runRules(sessions);
  const text = report(sessions, findings, { judged });
  assert.ok(!text.includes(".."), text);
});

test("an empty period says so rather than dividing by zero", () => {
  assert.match(report([], []), /No sessions/);
  const { findings } = runRules([]);
  assert.deepEqual(findings, []);
});

// --- compaction ------------------------------------------------------------

const comp = (over = {}) => ({ trigger: "auto", pre: 950000, post: 30000, at_min: 40, ...over });

test("too few compactions means no verdict at all", () => {
  const v = compactionVerdict(many(10, { compactions: [comp()] }).slice(0, 3));
  assert.equal(v.verdict, "not enough compactions to judge");
});

test("automatic compactions at the ceiling read as forced late", () => {
  const v = compactionVerdict(many(10, { compactions: [comp()], human_turns: 40 }));
  assert.equal(v.verdict, "forced late");
  assert.match(v.detail, /fired automatically/);
  assert.match(v.improve, /your own terms/);
});

test("manual compactions well below the ceiling read as by choice", () => {
  const v = compactionVerdict(many(10, {
    compactions: [comp({ trigger: "manual", pre: 400000, post: 200000 })], human_turns: 40 }));
  assert.equal(v.verdict, "by choice");
});

test("information loss is only claimed on enough repeated turns", () => {
  // Two repeated turns across the whole corpus looks alarming as a percentage
  // and means nothing. This is the shape of the owner's real data.
  const thin = compactionVerdict([
    ...many(2, { compactions: [comp({ trigger: "manual", pre: 400000, post: 200000 })],
                 human_turns: 40, turns_after_compaction: 5,
                 reexplain_after_compaction: 1, reexplain: 1 }),
    ...many(8, { compactions: [comp({ trigger: "manual", pre: 400000, post: 200000 })],
                 human_turns: 40, turns_after_compaction: 5 }),
  ]);
  assert.notEqual(thin.verdict, "lossy");
  assert.equal(thin.loss.tooFew, true);

  const solid = compactionVerdict(many(10, {
    compactions: [comp({ trigger: "manual", pre: 400000, post: 200000 })],
    human_turns: 40, turns_after_compaction: 20,
    reexplain_after_compaction: 12, reexplain: 15 }));
  assert.equal(solid.verdict, "lossy");
  assert.equal(solid.loss.events, 120);
  assert.ok(solid.loss.rateAfter > solid.loss.rateBase);
});

test("a zero baseline alone cannot make a verdict lossy", () => {
  // Every repeat falls after a compaction, so the baseline is exactly 0 and any
  // ratio against it is infinite. Ten repeats clear the event guard, but 1.7%
  // of turns is not information loss, and the absolute floor is what says so.
  const barely = compactionVerdict(many(10, {
    compactions: [comp({ trigger: "manual", pre: 400000, post: 200000 })],
    human_turns: 100, turns_after_compaction: 60,
    reexplain_after_compaction: 1, reexplain: 1 }));
  assert.equal(barely.loss.rateBase, 0, "nothing was repeated outside the window");
  assert.equal(barely.loss.events, 10, "the event guard is satisfied");
  assert.ok(barely.loss.rateAfter < 2);
  assert.notEqual(barely.verdict, "lossy");
});

test("sessions that ran hot without ever compacting are counted", () => {
  const v = compactionVerdict([...many(9, { ctx_peak: 900000, compactions: [] }),
                               ...many(9, { compactions: [comp()] })]);
  assert.equal(v.ranHot, 9);
});

// --- cost ------------------------------------------------------------------

const pricing = {
  cache_write_5m: 1.25, cache_write_1h: 2.0, cache_read: 0.1, fast_multiplier: 2.0,
  models: { "claude-opus-5": { in: 5, out: 25 }, "claude-haiku-4-5": { in: 1, out: 5 } },
};

test("cost uses list prices and separates cache writes from reads", () => {
  const s = S({ by_model: { "claude-opus-5": { calls: 1, in: 1e6, cc5: 0, cc1h: 0, cr: 0, out: 0 } } });
  assert.equal(costOf(s, pricing).usd, 5);
  const cached = S({ by_model: { "claude-opus-5": { calls: 1, in: 0, cc5: 1e6, cc1h: 0, cr: 0, out: 0 } } });
  assert.equal(costOf(cached, pricing).usd, 6.25, "a 5-minute cache write costs 1.25x input");
  const read = S({ by_model: { "claude-opus-5": { calls: 1, in: 0, cc5: 0, cc1h: 0, cr: 1e6, out: 0 } } });
  assert.equal(read && costOf(read, pricing).usd, 0.5, "a cache read costs a tenth of input");
});

test("a dated model id prices as its base model", () => {
  assert.equal(priceFor("claude-haiku-4-5-20251001", pricing).in, 1);
  assert.equal(priceFor("<synthetic>", pricing), null);
});

test("calls on an unknown model are reported rather than priced at zero", () => {
  const s = S({ by_model: { "<synthetic>": { calls: 7, in: 100, out: 100 } } });
  const r = costOf(s, pricing);
  assert.equal(r.usd, 0);
  assert.equal(r.unpriced, 7, "the card can say how much of the total is unpriced");
});

test("byte sizes are readable at every scale", () => {
  assert.equal(fmtBytes(500), "500 B");
  assert.equal(fmtBytes(2400), "2 KB");
  assert.equal(fmtBytes(4.2e6), "4.2 MB");
});

test("share reports the count as well as the percentage", () => {
  const r = share([...many(3, { interrupts: 1 }), ...many(1)], (s) => hard(s) > 0);
  assert.deepEqual([r.n, r.hits, r.pct], [4, 3, 75]);
});
