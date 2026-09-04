// insights.js — turn a session feed into ranked, explained findings.
//
// Every card the Prompting view shows comes from a rule in here. A rule is a
// pure function of the sessions in view, so the whole file is testable with
// node --test and none of it touches the DOM.
//
// The statistics policy, which the wording of every card depends on:
//
//   Most sessions contain zero hard corrections. A median per-session rate is
//   therefore usually exactly 0, and "1.5x the median" fires on any positive
//   number at all. So groups are compared by their POOLED rate - all the events
//   in the group over all the turns in the group - and a multiple is only ever
//   quoted when the reference group's own rate is high enough to divide by
//   (MIN_RATE_FOR_RATIO). Below that the card states the absolute gap instead.
//
//   Comparisons are associations. Every headline is written in the past tense
//   about what happened ("ran", "saw"), never as a claim about cause ("cut",
//   "caused"), and every card carries its n and a correlation note.

"use strict";

export const MIN_N = 5;                 // a group smaller than this is not shown
export const MIN_RATE_FOR_RATIO = 0.5;  // events per 10 turns, below which no "x" is quoted
export const Z = 1.96;

// ---------------------------------------------------------------- statistics

/** Events per 10 turns for a whole group, with the range this many events implies. */
export function pooledRate(sessions, events, turns) {
  let e = 0, t = 0;
  for (const s of sessions) { e += events(s) || 0; t += turns(s) || 0; }
  if (!t) return { n: sessions.length, events: e, turns: 0, rate: 0, bandLo: 0, bandHi: 0 };
  const rate = (e / t) * 10;
  const half = (Z * Math.sqrt(Math.max(e, 0)) / t) * 10;   // Poisson-ish on the count
  // Named band* rather than lo/hi: callers spread this into objects that have
  // their own lo/hi, and a silent overwrite printed a float where a turn count
  // belonged.
  return { n: sessions.length, events: e, turns: t, rate,
           bandLo: Math.max(0, rate - half), bandHi: rate + half };
}

export function share(sessions, pred) {
  if (!sessions.length) return { n: 0, hits: 0, pct: 0 };
  const hits = sessions.filter(pred).length;
  return { n: sessions.length, hits, pct: (hits / sessions.length) * 100 };
}

export function fmtBytes(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return Math.round(n / 1e3) + " KB";
  return Math.round(n) + " B";
}

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * How to describe the difference between two groups without overstating it.
 * Returns the ratio only when the reference rate can carry one.
 */
export function compare(worse, better) {
  const gap = worse.rate - better.rate;
  const canRatio = better.rate >= MIN_RATE_FOR_RATIO;
  return {
    gap, canRatio,
    ratio: canRatio ? worse.rate / better.rate : null,
    // The phrase a headline should use, so no card has to decide this itself.
    phrase: canRatio
      ? `${(worse.rate / better.rate).toFixed(1)} times`
      : `${gap >= 0 ? "" : "-"}${Math.abs(gap).toFixed(1)} more per 10 messages`,
    enough: worse.n >= MIN_N && better.n >= MIN_N,
  };
}

// ------------------------------------------------------------ session fields

// A revision the harness recorded: you stopped a run, rejected an edit, or
// rejected a plan. Mid-turn steering is NOT counted here - on this corpus it is
// six times more common than all three together, and sending a message while
// Claude works is usually adding information rather than undoing it. It gets
// its own signal instead of swamping this one.
export const hard = (s) => (s.interrupts || 0) + (s.denied_user || 0) + (s.denied_plan || 0);
export const steering = (s) => s.steering || 0;
export const turns = (s) => s.human_turns || 0;
export const anchors = (s) => (s.has_path ? 1 : 0) + (s.has_constraint ? 1 : 0) +
                              (s.has_done_criterion ? 1 : 0);
export const isResumed = (s) => !!s.resumed_from;
export const edited = (s) => (s.git_commits || 0) > 0 ||
  ["Edit", "Write", "NotebookEdit", "MultiEdit"].some((t) => (s.tools || {})[t]);
export const ctxPct = (s) => (s.ctx_window ? (s.ctx_peak / s.ctx_window) * 100 : 0);
export const noVisibleCorrection = (s) =>
  !isResumed(s) && (s.tool_calls_total || 0) >= 1 && hard(s) === 0 && (s.lex_corrections || 0) === 0;

export function tokensOf(s) {
  let n = 0;
  for (const b of Object.values(s.by_model || {})) {
    n += (b.in || 0) + (b.cc5 || 0) + (b.cc1h || 0) + (b.cr || 0) + (b.out || 0);
  }
  return n;
}

/** List price of a session, as a comparison unit. A subscription pays none of it. */
export function costOf(s, pricing) {
  if (!pricing) return { usd: 0, unpriced: 0 };
  let usd = 0, unpriced = 0;
  for (const [model, b] of Object.entries(s.by_model || {})) {
    const p = priceFor(model, pricing);
    if (!p) { unpriced += b.calls || 0; continue; }
    const mult = b.fast_calls && b.calls ? 1 + (pricing.fast_multiplier - 1) * (b.fast_calls / b.calls) : 1;
    const read = p.cache_read !== undefined ? p.cache_read : pricing.cache_read * p.in;
    usd += ((b.in || 0) * p.in
          + (b.cc5 || 0) * p.in * pricing.cache_write_5m
          + (b.cc1h || 0) * p.in * pricing.cache_write_1h
          + (b.cr || 0) * (p.cache_read !== undefined ? read : pricing.cache_read * p.in)
          + (b.out || 0) * p.out) / 1e6 * mult;
  }
  return { usd, unpriced };
}

export function priceFor(model, pricing) {
  if (!model || !pricing) return null;
  const m = pricing.models || {};
  if (m[model]) return m[model];
  // Dated ids (claude-haiku-4-5-20251001) price as their base model.
  const hit = Object.keys(m).find((k) => model.startsWith(k));
  return hit ? m[hit] : null;
}

// ---------------------------------------------------------------- the rules
//
// Each rule returns null when it has nothing trustworthy to say, or a finding:
//   { id, headline, chart, wentWrong, improve, promptShape, howToRead,
//     confidence, effect, reach, n }
// The view renders every finding the same way, so the shape is the contract.

const CORRELATION = "Sessions differ in more than this one thing, so treat it as a pattern worth trying, not proof.";

function groupCompare(opts) {
  const { worse, better, events = hard, den = turns } = opts;
  const a = pooledRate(worse, events, den);
  const b = pooledRate(better, events, den);
  const c = compare(a, b);
  return { a, b, c };
}

export const RULES = [
  {
    id: "first_prompt_anchors",
    title: "Anchors in the opening message",
    run(ctx) {
      const pool = ctx.sessions.filter((s) => !isResumed(s) && (s.tool_calls_total || 0) >= 1);
      const few = pool.filter((s) => anchors(s) <= 1);
      const many = pool.filter((s) => anchors(s) >= 2);
      const { a, b, c } = groupCompare({ worse: few, better: many });
      if (!c.enough || c.gap <= 0) return null;
      const buckets = [0, 1, 2, 3].map((k) => {
        const g = pool.filter((s) => anchors(s) === k);
        return { label: `${k} of three`, ...pooledRate(g, hard, turns) };
      });
      const pctFew = (few.length / pool.length) * 100;
      return {
        headline: c.canRatio
          ? `First messages that named at most one of the file, the limit and the check needed ${c.phrase} as many corrections`
          : `First messages that named at most one of the file, the limit and the check needed ${c.phrase} corrections`,
        chart: { kind: "bars", buckets, xTitle: "corrections per 10 messages",
                 highlight: buckets.findIndex((x) => x.n === Math.max(...buckets.map((y) => y.n))),
                 reference: pooledRate(pool, hard, turns).rate, referenceLabel: "your overall rate" },
        wentWrong: `Three things help most in a first message: where the code is, what must not change, and how to tell it worked. In ${pctFew.toFixed(0)}% of your sessions you named at most one of them. Those needed ${a.rate.toFixed(1)} corrections for every 10 messages you sent; the ones with two or three needed ${b.rate.toFixed(1)}.`,
        improve: "Say all three up front, even when the job feels obvious: where the code is, what must not change, and how you will both know it worked.",
        promptShape: "In <path>, <change>. Do not touch <area>. Done when `<command>` shows <result>.",
        howToRead: "Sessions are grouped by how many of those three the first message mentioned. The bar is how often you had to correct Claude in that group, per 10 messages you sent. The thin line through it is the range you would expect from this few events, so short bars with long lines are not really different. The dotted line is your average. Grey bars have fewer than five sessions behind them.",
        confidence: `${few.length} sessions named one or none, ${many.length} named two or three. These three are spotted by pattern-matching your text, not by understanding it. ${CORRELATION}`,
        effect: c.canRatio ? Math.min(2, c.ratio - 1) : c.gap / 2,
        reach: few.length / Math.max(1, pool.length), n: pool.length,
      };
    },
  },
  {
    id: "long_session_knee",
    title: "How long a session runs",
    run(ctx) {
      const bands = [[1, 5], [6, 15], [16, 40], [41, Infinity]];
      const pool = ctx.sessions.filter((s) => turns(s) >= 1);
      const buckets = bands.map(([lo, hi]) => {
        const g = pool.filter((s) => turns(s) >= lo && turns(s) <= hi);
        return {
          label: hi === Infinity ? `${lo}+ turns` : `${lo}-${hi} turns`,
          ...pooledRate(g, hard, turns),
          from: lo,
          compacted: share(g, (s) => (s.compactions || []).length > 0).pct,
          ctx: median(g.map(ctxPct)),
        };
      });
      const usable = buckets.filter((x) => x.n >= MIN_N);
      if (usable.length < 3) return null;
      const first = usable[0], last = usable[usable.length - 1];
      const c = compare(last, first);
      if (!c.enough || c.gap <= 0) return null;
      const knee = usable.find((x) => x !== first && x.rate >= first.rate * 1.3);
      return {
        headline: c.canRatio
          ? `After about ${(knee || last).from} messages, you correct Claude ${c.phrase} more often`
          : `Longer sessions ran ${c.phrase} more corrections`,
        chart: { kind: "bars", buckets, xTitle: "corrections per 10 messages",
                 highlight: buckets.indexOf(last), strip: true },
        wentWrong: `${last.n} of your sessions went on for ${last.label}. In those you corrected Claude ${last.rate.toFixed(1)} times per 10 messages, against ${first.rate.toFixed(1)} in the shortest ones, and ${last.compacted.toFixed(0)}% of them ran out of room and had to be compacted.`,
        improve: "Finish one thing per session. When it starts to drag, ask for a short handover note, commit whatever passes, and start again with that note as your first message. A fresh session beats a tired one.",
        promptShape: "Continuing earlier work. State: <what is done, verified by what>. Files: <paths>. Constraints: <list>. Next: <one goal>. Done when: <check>. Do not redo <finished step>.",
        howToRead: "Sessions grouped by how long they ran, counted in messages you sent. The bar is how often you had to correct Claude in that group. Long sessions are long partly because the work was hard, so this is not only about fatigue.",
        confidence: `${pool.length} sessions, in ${usable.length} groups big enough to read. ${CORRELATION}`,
        effect: c.canRatio ? Math.min(2, c.ratio - 1) : c.gap / 2,
        reach: last.n / Math.max(1, pool.length), n: pool.length,
      };
    },
  },
  {
    id: "resumed_vs_fresh",
    title: "Resuming versus starting fresh",
    run(ctx) {
      const pool = ctx.sessions.filter((s) => (s.tool_calls_total || 0) >= 1);
      const resumed = pool.filter(isResumed), fresh = pool.filter((s) => !isResumed(s));
      const { a, b, c } = groupCompare({ worse: resumed, better: fresh });
      if (!c.enough || c.gap <= 0) return null;
      return {
        headline: c.canRatio
          ? `Picking up an old session needed ${c.phrase} as many corrections as starting fresh`
          : `Picking up an old session needed ${c.phrase} more corrections than starting fresh`,
        chart: { kind: "dots", rows: [
          { label: "fresh start", ...b, accent: false },
          { label: "resumed", ...a, accent: true }], xTitle: "corrections per 10 messages" },
        wentWrong: `${resumed.length} of your sessions carried on from an earlier one. In those you corrected Claude ${a.rate.toFixed(1)} times per 10 messages, against ${b.rate.toFixed(1)} when you started fresh.`,
        improve: "An old session is long and may already have been compacted, so what Claude still remembers is not what you remember. Say where things stand in one message instead of assuming.",
        promptShape: "Resuming <task>. Verified so far: <fact + how verified>. Unverified: <fact>. Files: <paths>. Next: <goal>. Done when: <check>.",
        howToRead: "Each row is a group of sessions. The dot is how often you corrected Claude, per 10 messages you sent. The line through it is the range you would expect from this few events.",
        confidence: `${resumed.length} carried on, ${fresh.length} started fresh. People tend to carry on with the sessions that were already going badly. ${CORRELATION}`,
        effect: c.canRatio ? Math.min(2, c.ratio - 1) : c.gap / 2,
        reach: resumed.length / Math.max(1, pool.length), n: pool.length,
      };
    },
  },
  {
    id: "plan_mode_big_tasks",
    title: "Planning before big tasks",
    run(ctx) {
      const pool = ctx.sessions.filter((s) => !isResumed(s) && (s.tool_calls_total || 0) >= 1);
      if (pool.length < MIN_N * 2) return null;
      const cut = median(pool.map((s) => s.tool_calls_total || 0));
      const big = pool.filter((s) => (s.tool_calls_total || 0) >= cut);
      const planned = big.filter((s) => s.plan_mode || s.mentions_plan);
      const not = big.filter((s) => !(s.plan_mode || s.mentions_plan));
      const ev = (s) => (s.denied_user || 0) + (s.interrupts_tool || 0);
      const den = (s) => (s.tool_calls_total || 0) / 10;   // per 100 tool calls
      const a = pooledRate(not, ev, den), b = pooledRate(planned, ev, den);
      const c = compare(a, b);
      if (!c.enough || c.gap <= 0) return null;
      return {
        headline: `On big jobs, planning first meant ${b.rate.toFixed(1)} rejected or stopped actions per 100, against ${a.rate.toFixed(1)} without a plan`,
        chart: { kind: "dots", rows: [
          { label: "planned first", ...b, accent: true },
          { label: "no plan", ...a, accent: false }], xTitle: "rejected or stopped actions per 100" },
        wentWrong: `${not.length} of your ${big.length} biggest sessions started without a plan. Big here means ${cut} actions or more, which is your own halfway mark.`,
        improve: "For anything touching more than about three files, or code you do not know well, ask for the plan first and hold it there. Turning down a plan costs one message. Turning down the edits it would have made costs a lot more.",
        promptShape: "Plan first, no edits yet: <goal> in <path>. List the files you will touch, the order, the risks and the check you will run. Wait for my go-ahead.",
        howToRead: "Only the bigger half of your sessions, measured by how many actions Claude took. The dot counts the edits you turned down and the actions you stopped, per 100 actions, so one very long session cannot swamp the rest.",
        confidence: `${planned.length} planned, ${not.length} did not. You probably already plan the jobs you know are risky, which cuts both ways. ${CORRELATION}`,
        effect: c.canRatio ? Math.min(2, c.ratio - 1) : c.gap / 2,
        reach: not.length / Math.max(1, pool.length), n: big.length,
      };
    },
  },
  {
    id: "claude_asked",
    title: "Letting Claude ask first",
    run(ctx) {
      const pool = ctx.sessions.filter((s) => !isResumed(s) && (s.tool_calls_total || 0) >= 10);
      const asked = pool.filter((s) => (s.askuser || 0) >= 1);
      const never = pool.filter((s) => !(s.askuser || 0));
      // Answers to Claude's questions are themselves turns, so they are removed
      // from the denominator: otherwise the "asked" group looks better by
      // arithmetic alone.
      const ev = (s) => (s.interrupts || 0) + (s.steering || 0);
      const den = (s) => Math.max(1, turns(s) - (s.askuser || 0));
      const a = pooledRate(never, ev, den), b = pooledRate(asked, ev, den);
      const c = compare(a, b);
      if (!c.enough || c.gap <= 0) return null;
      return {
        headline: c.canRatio
          ? `When Claude asked you something first, you interrupted it ${c.phrase} less`
          : `When Claude asked you something first, you interrupted it ${c.phrase} less`,
        chart: { kind: "dots", rows: [
          { label: "asked at least once", ...b, accent: true },
          { label: "never asked", ...a, accent: false }], xTitle: "interruptions per 10 messages" },
        wentWrong: `In ${((never.length / Math.max(1, pool.length)) * 100).toFixed(0)}% of your busy sessions Claude never asked you anything. In those you interrupted or redirected it ${a.rate.toFixed(1)} times per 10 messages, against ${b.rate.toFixed(1)} when it did ask.`,
        improve: "When the job is open to interpretation, end your first message by inviting a few questions, then answer them all at once. Better to spend one message up front than to keep stopping it later.",
        promptShape: "<task>. Before you start, ask me up to 3 questions whose answers would change your approach. Then wait for my reply.",
        howToRead: "Your replies to Claude's own questions are left out of the count, otherwise asking would look good simply because it adds messages. Claude also asks more on vague jobs, which are the ones you would interrupt anyway.",
        confidence: `It asked in ${asked.length} sessions and stayed quiet in ${never.length}. ${CORRELATION}`,
        effect: c.canRatio ? Math.min(2, c.ratio - 1) : c.gap / 2,
        reach: never.length / Math.max(1, pool.length), n: pool.length,
      };
    },
  },
  {
    id: "tool_output_bloat",
    title: "What fills the context window",
    run(ctx) {
      const totals = {};
      let all = 0;
      for (const s of ctx.sessions) {
        for (const [tool, bytes] of Object.entries(s.tool_bytes || {})) {
          totals[tool] = (totals[tool] || 0) + bytes;
          all += bytes;
        }
      }
      const ranked = Object.entries(totals).sort((x, y) => y[1] - x[1]).slice(0, 8);
      if (!ranked.length || !all) return null;
      const [topTool, topBytes] = ranked[0];
      const pct = (topBytes / all) * 100;
      const heavy = ctx.sessions.filter((s) => ctxPct(s) >= 70);
      const light = ctx.sessions.filter((s) => ctxPct(s) < 70);
      if (pct < 40 || heavy.length < MIN_N || light.length < MIN_N) return null;
      const bytesOf = (s) => Object.values(s.tool_bytes || {}).reduce((n, v) => n + v, 0);
      const mh = median(heavy.map(bytesOf)), ml = median(light.map(bytesOf));
      const calls = ctx.sessions.reduce((n, s) => n + ((s.tools || {})[topTool] || 0), 0);
      return {
        headline: `The ${topTool} tool alone accounts for ${pct.toFixed(0)}% of everything read into your conversations`,
        chart: { kind: "bars", horizontal: true,
                 buckets: ranked.map(([t, b]) => ({ label: t, rate: b / 1e6, n: MIN_N,
                   bandLo: b / 1e6, bandHi: b / 1e6,
                   calls: ctx.sessions.reduce((n2, s) => n2 + ((s.tools || {})[t] || 0), 0) })),
                 xTitle: "megabytes returned into the conversation", highlight: 0 },
        wentWrong: `${topTool} returned ${(topBytes / 1e6).toFixed(1)} MB across ${calls} calls. The sessions that filled more than 70% of their context window read ${fmtBytes(mh)} of tool output on average, against ${fmtBytes(ml)} for the rest.`,
        improve: "Read less. Search first, ask for the lines you need instead of whole files, and hand wide exploration to a subagent that comes back with a summary rather than the text itself.",
        promptShape: "Explore <area> with a subagent and return only: files involved (max 10), function names with line ranges, a 5-line summary. Cap command output with | tail -40.",
        howToRead: "How much each tool has poured into your conversations, across every session shown. Roughly four bytes to a token. Some of it had to be read, so this shows where the space went, not that it was wasted.",
        confidence: `Across ${ctx.sessions.length} sessions and ${Object.keys(totals).length} tools. ${CORRELATION}`,
        effect: Math.min(2, pct / 40), reach: 1, n: ctx.sessions.length,
      };
    },
  },
  {
    id: "cache_resets",
    title: "Idle gaps and conversation restarts",
    run(ctx) {
      const pool = ctx.sessions.filter((s) => (s.tool_calls_total || 0) >= 10);
      if (pool.length < MIN_N * 2) return null;
      const withReset = pool.filter((s) => (s.cache_resets || 0) >= 1);
      if (withReset.length < MIN_N) return null;
      const pctSessions = (withReset.length / pool.length) * 100;
      const totalResets = pool.reduce((n, s) => n + (s.cache_resets || 0), 0);
      const writeShare = (list) => {
        let w = 0, t = 0;
        for (const s of list) for (const b of Object.values(s.by_model || {})) {
          w += (b.cc5 || 0) + (b.cc1h || 0);
          t += (b.in || 0) + (b.cc5 || 0) + (b.cc1h || 0) + (b.cr || 0);
        }
        return t ? (w / t) * 100 : 0;
      };
      return {
        headline: `The whole conversation was re-sent ${totalResets} times across ${withReset.length} sessions`,
        chart: { kind: "dots", rows: [
          { label: "sessions with a reset", n: withReset.length, rate: writeShare(withReset),
            bandLo: writeShare(withReset), bandHi: writeShare(withReset), accent: true },
          { label: "sessions without", n: pool.length - withReset.length,
            rate: writeShare(pool.filter((s) => !(s.cache_resets || 0))), bandLo: 0, bandHi: 0, accent: false },
        ], xTitle: "share of input tokens spent writing cache, %" },
        wentWrong: `This happened in ${pctSessions.toFixed(0)}% of your busy sessions. Claude keeps a copy of the conversation so it does not have to re-read it every time, and that copy expires if you leave it long enough. When it does, everything is sent again, at about ten times the price of reading the copy.`,
        improve: "What expires it is a long pause. If you need to step away mid-session, finish the current step first, or note where you are and come back to a new session.",
        promptShape: "Before I step away: write where we are to <path>/HANDOFF.md, so we can pick it up in a fresh session.",
        howToRead: "Counted whenever the amount Claude read from its saved copy suddenly halves, which means the copy had gone. The dots compare how much of each group went on making a new copy rather than reading the old one.",
        confidence: `${pool.length} busy sessions. How long the copy survives is partly out of your hands.`,
        effect: Math.min(2, totalResets / Math.max(1, pool.length)), reach: withReset.length / pool.length, n: pool.length,
      };
    },
  },
  // --- rules that need judged sessions ------------------------------------
  {
    id: "first_prompt_score",
    title: "How complete your first messages are",
    needsJudged: true,
    run(ctx) {
      const pool = ctx.judged.filter((s) => (s.tool_calls_total || 0) >= 1);
      const band = (lo, hi) => pool.filter((s) => s.j.score >= lo && s.j.score <= hi);
      const buckets = [[0, 1], [2, 3], [4, 5]].map(([lo, hi]) => ({
        label: `${lo}-${hi}`, ...pooledRate(band(lo, hi), hard, turns),
      }));
      const low = buckets[0], high = buckets[2].n >= MIN_N ? buckets[2] : buckets[1];
      const c = compare(low, high);
      if (!c.enough || c.gap <= 0) return null;
      return {
        headline: c.canRatio
          ? `First messages scored 1 or less needed ${c.phrase} as many corrections`
          : `First messages scored 1 or less needed ${c.phrase} more corrections`,
        chart: { kind: "bars", buckets, xTitle: "corrections per 10 messages", highlight: 0 },
        wentWrong: `${low.n} of your sessions began with a message that scored at most 1 out of 5. Those needed ${low.rate.toFixed(1)} corrections per 10 messages, against ${high.rate.toFixed(1)} for your best-scored openings.`,
        improve: "Before you press enter, check your first message says five things: what you want, where the code is, what works today, how you will know it is finished, and one thing to leave alone.",
        promptShape: "Goal: <one sentence>. Where: <path>. Current state: <what works / what fails>. Done when: <command and expected output>. Do not: <boundary>. Scope: only <files>.",
        howToRead: "Sessions grouped by how the review scored your first message, one point for each of the five things it looks for. The bar is how often you had to correct Claude in that group.",
        confidence: `${pool.length} reviewed sessions. The score reads your message, not the job. Harder jobs tend to get vaguer descriptions and more corrections both. ${CORRELATION}`,
        effect: c.canRatio ? Math.min(2, c.ratio - 1) : c.gap / 2,
        reach: low.n / Math.max(1, pool.length), n: pool.length,
      };
    },
  },
  {
    id: "correction_causes",
    title: "Why your corrections happened",
    needsJudged: true,
    run(ctx) {
      const counts = {}; let attributed = 0, labelled = 0;
      for (const s of ctx.judged) {
        for (const t of s.j.turns || []) {
          if (["correction", "re_explain", "scope_change", "interrupt"].includes(t.label)) labelled++;
          if (t.cause) { counts[t.cause] = (counts[t.cause] || 0) + 1; attributed++; }
        }
      }
      if (attributed < 20 || ctx.judged.length < MIN_N) return null;
      const gap = counts.prompt_gap || 0;
      const pct = (gap / attributed) * 100;
      if (pct < 35) return null;
      const names = { prompt_gap: "the prompt was missing something", model_error: "the model went wrong with a clear ask",
                      scope_change: "you changed the goal", env_issue: "tools or environment failed",
                      context_loss: "Claude had been told and lost it" };
      return {
        headline: `Most of your corrections trace back to what was asked, not to what Claude did`,
        chart: { kind: "bars", horizontal: true,
                 buckets: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({
                   label: names[k] || k, rate: v, n: MIN_N, bandLo: v, bandHi: v })),
                 xTitle: "corrections", highlight: 0 },
        wentWrong: `Of the ${attributed} corrections with a reason attached, ${gap} came down to something missing from what you asked. Another ${labelled - attributed} had no reason recorded.`,
        improve: "Treat every prompt-gap correction as a missing line in your first message. Keep a short standing preamble and paste it at the top of each new session.",
        promptShape: "Standing rules: <rule 1>; <rule 2>; <rule 3>. Task: <goal>. Where: <path>. Done when: <check>. If anything is ambiguous, ask before editing.",
        howToRead: "Each bar counts the corrections put down to one cause. Prompt gap means your message left something out. Model error means the ask was clear and Claude still got it wrong. The rest are you changing your mind, and something breaking. Each reason is one model's opinion, and it leans towards blaming the prompt, so trust the order more than the numbers.",
        confidence: `${attributed} corrections with a reason, across ${ctx.judged.length} reviewed sessions.`,
        effect: Math.min(2, pct / 35), reach: 1, n: ctx.judged.length,
      };
    },
  },
  {
    id: "missing_ingredient_cost",
    title: "The ingredient you leave out most",
    needsJudged: true,
    run(ctx) {
      const items = ["files/locations", "expected output shape", "acceptance check",
                     "constraints", "current state", "how far it should go", "priority"];
      const rows = [];
      for (const item of items) {
        const missing = ctx.judged.filter((s) => (s.j.missing || []).includes(item));
        const present = ctx.judged.filter((s) => !(s.j.missing || []).includes(item));
        if (missing.length < MIN_N || present.length < MIN_N) continue;
        const a = pooledRate(missing, hard, turns), b = pooledRate(present, hard, turns);
        rows.push({ item, a, b, gap: a.rate - b.rate,
                    pct: (missing.length / ctx.judged.length) * 100 });
      }
      if (!rows.length) return null;
      rows.sort((x, y) => y.gap - x.gap);
      const top = rows[0];
      if (top.gap <= 0) return null;
      return {
        headline: `Leaving out ${top.item} went with ${top.gap.toFixed(1)} more corrections per 10 messages`,
        chart: { kind: "dumbbell", rows: rows.map((r) => ({
          label: `${r.item} (left out in ${r.pct.toFixed(0)}%)`, a: r.b.rate, b: r.a.rate })),
          xTitle: "corrections per 10 messages" },
        wentWrong: `Your first message left out ${top.item} in ${top.pct.toFixed(0)}% of reviewed sessions. Those needed ${top.a.rate.toFixed(1)} corrections per 10 messages, against ${top.b.rate.toFixed(1)} when you included it.`,
        improve: `Put ${top.item} in every first message this week and see if this number moves. It is one habit, not five.`,
        promptShape: "Goal: <one sentence>. Current state: <what exists / what was tried>. Files: <paths>. Output: <a PR / a file / a table / an answer>. Check: <how we know it worked>.",
        howToRead: "One row per thing the review looks for. The grey dot is how often you corrected Claude when your first message included it, the blue dot when it did not, and the line between them is the difference.",
        confidence: `${ctx.judged.length} reviewed sessions. This is the biggest of ${rows.length} comparisons, which makes the top row the least reliable one. Trust the order more than the number. ${CORRELATION}`,
        effect: Math.min(2, top.gap / 2), reach: top.pct / 100, n: ctx.judged.length,
      };
    },
  },
];

// ------------------------------------------------------------------ compaction
//
// Its own card because the user asked the question directly: am I compacting
// too much, and does it lose information?

export function compactionVerdict(sessions) {
  const comps = sessions.flatMap((s) => (s.compactions || []).map((c) => ({ ...c, sid: s.sid })));
  const withC = sessions.filter((s) => (s.compactions || []).length);
  const totalTurns = sessions.reduce((n, s) => n + turns(s), 0);
  const per100 = totalTurns ? (comps.length / totalTurns) * 100 : 0;
  const auto = comps.filter((c) => c.trigger === "auto").length;
  const autoPct = comps.length ? (auto / comps.length) * 100 : 0;
  const pres = comps.map((c) => c.pre).filter(Boolean);
  const medPre = median(pres);
  const drops = comps.filter((c) => c.pre && c.post).map((c) => ((c.pre - c.post) / c.pre) * 100);
  const medDrop = median(drops);
  const ranHot = sessions.filter((s) => ctxPct(s) >= 80 && !(s.compactions || []).length).length;

  // The information-loss comparison, only when there is enough after a
  // compaction to compare at all.
  const after = sessions.reduce((n, s) => n + (s.turns_after_compaction || 0), 0);
  const afterRe = sessions.reduce((n, s) => n + (s.reexplain_after_compaction || 0), 0);
  // Clamped: a feed where the post-compaction window overlaps oddly must not
  // produce a negative denominator and a -0 rate.
  const baseTurns = Math.max(0, totalTurns - after);
  const baseRe = Math.max(0, sessions.reduce((n, s) => n + (s.reexplain || 0), 0) - afterRe);
  // The critic's guard: a rate built on two repeated turns is not evidence of
  // information loss, however large the percentage looks.
  const MIN_LOSS_EVENTS = 10;
  // A baseline of zero makes any ratio infinite, so the claim also has to clear
  // an absolute bar before the word "lossy" is used.
  const MIN_LOSS_RATE = 2;   // repeated turns as a percentage of turns after a compaction
  const canCompareLoss = afterRe >= MIN_LOSS_EVENTS && after >= 10 && withC.length >= MIN_N;
  const rateAfter = after ? (afterRe / after) * 100 : 0;
  const rateBase = baseTurns ? (baseRe / baseTurns) * 100 : 0;

  let verdict, detail;
  if (canCompareLoss && rateAfter >= rateBase * 1.5 && rateAfter >= MIN_LOSS_RATE) {
    verdict = "lossy";
    detail = `After a compaction you repeated earlier wording in ${rateAfter.toFixed(1)}% of turns against ${rateBase.toFixed(1)}% otherwise.`;
  } else if (comps.length >= 8 && (autoPct >= 70 || medPre >= 850000)) {
    verdict = "forced late";
    detail = `${autoPct.toFixed(0)}% of your compactions fired automatically, at a median ${(medPre / 1000).toFixed(0)}K tokens, dropping ${medDrop.toFixed(0)}% of the context in one step.`;
  } else if (ranHot >= 5 && ranHot >= withC.length) {
    // Not compacting is also an answer, and it is the one this corpus gives:
    // sessions ride to the ceiling and pay full price for the whole window on
    // every call. Reaching "by choice" here would have praised the opposite.
    verdict = "left too late";
    detail = `${ranHot} sessions ran past 80% of the context window without ever compacting, against ${withC.length} that compacted at all.`;
  } else if (comps.length < 8) {
    verdict = "not enough compactions to judge";
    detail = `${comps.length} compactions so far. This card needs 8 before it draws a conclusion.`;
  } else if (per100 > 3) {
    verdict = "often";
    detail = `${per100.toFixed(1)} compactions per 100 turns is frequent enough to be worth pacing.`;
  } else {
    verdict = "by choice";
    detail = `${(100 - autoPct).toFixed(0)}% of your compactions were manual, none of them fired at the ceiling, and the turns after them show no excess repetition.`;
  }

  return {
    verdict, detail, count: comps.length, per100, autoPct, medPre, medDrop,
    ranHot, sessionsWith: withC.length,
    loss: canCompareLoss ? { rateAfter, rateBase, after, events: afterRe }
                         : { tooFew: true, after, events: afterRe },
    points: comps,
    improve: (verdict === "forced late" || verdict === "left too late")
      ? "Compact on your own terms at a task boundary, around 60 to 75% of the window, after asking for a handoff note saved to a file. A compaction at the ceiling drops almost everything at once, and every call before it pays for the whole window."
      : (verdict === "lossy"
        ? "Write the state to a file before compacting and paste it back afterwards, rather than re-explaining from memory."
        : "Keep compacting at task boundaries rather than waiting for the ceiling."),
    promptShape: "Before we continue: write a handoff to <path>/HANDOFF.md with decisions made, files touched, verified facts and the exact next step. Then compact, keeping that file.",
    howToRead: "Each dot is one compaction: how far into the session it happened, and how full the context was when it fired. The line below each dot falls to what was kept. Blue dots you triggered; grey ones fired automatically at the ceiling.",
  };
}

// ------------------------------------------------------------------ the engine

export function runRules(sessions, opts = {}) {
  const judged = sessions.filter((s) => s.j && s.j.score !== undefined);
  const ctx = { sessions, judged, ...opts };
  const findings = [], locked = [];
  for (const rule of RULES) {
    if (rule.needsJudged && judged.length < MIN_N) {
      locked.push({ id: rule.id, title: rule.title,
                    reason: `needs ${MIN_N} judged sessions, has ${judged.length}` });
      continue;
    }
    let f = null;
    try { f = rule.run(ctx); } catch (_) { f = null; }
    if (f) findings.push({ id: rule.id, title: rule.title, ...f });
    else locked.push({ id: rule.id, title: rule.title, reason: "nothing stands out yet" });
  }
  for (const f of findings) {
    f.score = (f.effect || 0) * (f.reach || 0) * Math.min(1, (f.n || 0) / 20);
  }
  findings.sort((a, b) => b.score - a.score);
  return { findings, locked, judged: judged.length };
}

/** The paragraph at the top of the page, built from the strongest findings. */
export function report(sessions, findings, extra = {}) {
  if (!sessions.length) return "Nothing recorded in this period yet.";
  const clean = share(sessions, noVisibleCorrection);
  const parts = [];
  parts.push(`Across ${sessions.length} sessions, ${clean.pct.toFixed(0)}% ran start to finish without you stepping in.`);
  if (extra.judged) parts.push(`${extra.judged} have been read through in detail.`);
  if (!findings.length) {
    parts.push("Nothing stands out yet. The checks below start reporting once there are enough sessions behind them.");
    return parts.join(" ");
  }
  parts.push(`The thing most worth changing: ${lower(findings[0].headline)}.`);
  if (findings[1]) parts.push(`After that, ${lower(findings[1].headline)}.`);
  parts.push(`If you change one thing tomorrow, make it this: ${trimStop(findings[0].improve.split(". ")[0])}.`);
  return parts.join(" ");
}

/** Lower-case a headline for mid-sentence use, but leave names like Read alone. */
function lower(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
function trimStop(text) {
  return text.replace(/\.$/, "");
}
