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
      ? `${(worse.rate / better.rate).toFixed(1)}x`
      : `${gap >= 0 ? "+" : ""}${gap.toFixed(1)} per 10 turns`,
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

const CORRELATION = "Sessions differ in more than this one thing, so read it as an association, not a cause.";

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
        return { label: `${k} anchor${k === 1 ? "" : "s"}`, ...pooledRate(g, hard, turns) };
      });
      const pctFew = (few.length / pool.length) * 100;
      return {
        headline: c.canRatio
          ? `Openers with at most one anchor ran ${c.phrase} the hard revisions`
          : `Openers with at most one anchor ran ${c.phrase} more hard revisions`,
        chart: { kind: "bars", buckets, xTitle: "hard revisions per 10 turns",
                 highlight: buckets.findIndex((x) => x.n === Math.max(...buckets.map((y) => y.n))),
                 reference: pooledRate(pool, hard, turns).rate, referenceLabel: "your overall rate" },
        wentWrong: `${pctFew.toFixed(0)}% of your openers carried at most one of the three anchors. Those sessions ran ${a.rate.toFixed(1)} hard revisions per 10 turns against ${b.rate.toFixed(1)} when two or more were present.`,
        improve: "Open with all three even when the task feels obvious: one path, one thing that must not change, one check that proves it is done.",
        promptShape: "In <path>, <change>. Do not touch <area>. Done when `<command>` shows <result>.",
        howToRead: "Each bar is a group of sessions, grouped by how many of the three anchors the first message carried. Bar length is that whole group's hard corrections per 10 of your turns; the whiskers show the range that many events implies. The dashed line is your overall rate. Grey bars have too few sessions to read.",
        confidence: `${few.length} sessions with 0-1 anchors, ${many.length} with 2-3. Anchors are detected by pattern, not by reading. ${CORRELATION}`,
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
          ? `Past ${(knee || last).from} turns, hard revisions ran ${c.phrase} higher`
          : `Longer sessions ran ${c.phrase} more hard corrections`,
        chart: { kind: "bars", buckets, xTitle: "hard revisions per 10 turns",
                 highlight: buckets.indexOf(last), strip: true },
        wentWrong: `${last.n} sessions ran to ${last.label}. They averaged ${last.rate.toFixed(1)} hard revisions per 10 turns against ${first.rate.toFixed(1)} in ${first.label}, and ${last.compacted.toFixed(0)}% of them compacted.`,
        improve: "One session per deliverable. At the knee, ask for a handoff note, commit what passes, and open a new session with that note as its first message.",
        promptShape: "Continuing earlier work. State: <what is done, verified by what>. Files: <paths>. Constraints: <list>. Next: <one goal>. Done when: <check>. Do not redo <finished step>.",
        howToRead: "Sessions grouped by how many messages you sent. Bar length is that group's hard corrections per 10 turns. The strip above each bar gives the share that compacted and the median peak context. Long sessions are long partly because they were hard.",
        confidence: `${pool.length} sessions across ${usable.length} readable groups. ${CORRELATION}`,
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
          ? `Resumed sessions ran ${c.phrase} the hard revisions of fresh starts`
          : `Resumed sessions ran ${c.phrase} more hard revisions than fresh starts`,
        chart: { kind: "dots", rows: [
          { label: "fresh start", ...b, accent: false },
          { label: "resumed", ...a, accent: true }], xTitle: "hard revisions per 10 turns" },
        wentWrong: `${resumed.length} sessions continued earlier work and ran ${a.rate.toFixed(1)} hard revisions per 10 turns against ${b.rate.toFixed(1)} for fresh starts.`,
        improve: "A resumed transcript is long and may already be compacted. Restate the verified current state in one message rather than trusting it to be reconstructed.",
        promptShape: "Resuming <task>. Verified so far: <fact + how verified>. Unverified: <fact>. Files: <paths>. Next: <goal>. Done when: <check>.",
        howToRead: "Each row is a group of sessions. The dot is the group's hard corrections per 10 of your turns; the line is the range that many events implies.",
        confidence: `${resumed.length} resumed, ${fresh.length} fresh. People resume the sessions that were already hard. ${CORRELATION}`,
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
        headline: `On big tasks, sessions that planned first had ${b.rate.toFixed(1)} rejected or interrupted tool calls per 100, against ${a.rate.toFixed(1)} without`,
        chart: { kind: "dots", rows: [
          { label: "planned first", ...b, accent: true },
          { label: "no plan", ...a, accent: false }], xTitle: "rejected or interrupted tool calls per 100" },
        wentWrong: `${not.length} of your ${big.length} big sessions (${cut}+ tool calls) started without a plan, and you planned in only ${((planned.length / Math.max(1, big.length)) * 100).toFixed(0)}% of them.`,
        improve: "For anything touching more than about three files, or unfamiliar code, ask for a plan and stop before edits. Rejecting a plan costs one turn; rejecting edits costs many.",
        promptShape: "Plan first, no edits yet: <goal> in <path>. List the files you will touch, the order, the risks and the check you will run. Wait for my go-ahead.",
        howToRead: "Only sessions at or above your median tool-call count. The dot is rejected edits plus interrupted tool calls per 100 tool calls, so a long session does not dominate.",
        confidence: `${planned.length} planned, ${not.length} unplanned big sessions. You may already reserve planning for tasks you know are risky. ${CORRELATION}`,
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
          ? `When Claude asked at least once, interrupts and steers ran ${c.phrase} lower`
          : `When Claude asked at least once, interrupts and steers ran ${c.phrase} lower`,
        chart: { kind: "dots", rows: [
          { label: "asked at least once", ...b, accent: true },
          { label: "never asked", ...a, accent: false }], xTitle: "interrupts and mid-turn steers per 10 turns" },
        wentWrong: `Claude asked you nothing in ${((never.length / Math.max(1, pool.length)) * 100).toFixed(0)}% of your busy sessions. Those ran ${a.rate.toFixed(1)} interrupts and steers per 10 turns against ${b.rate.toFixed(1)} when it asked.`,
        improve: "For anything ambiguous, end the opener with a capped invitation to ask, and answer everything in one message so the run is not interrupted later.",
        promptShape: "<task>. Before you start, ask me up to 3 questions whose answers would change your approach. Then wait for my reply.",
        howToRead: "Your answers to Claude's own questions are excluded from the turn count, so the comparison is not flattered by the extra turns they add. Claude asks more on ambiguous tasks, which also attract steering.",
        confidence: `${asked.length} sessions where it asked, ${never.length} where it did not. ${CORRELATION}`,
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
        headline: `${topTool} put ${pct.toFixed(0)}% of all tool output into your context`,
        chart: { kind: "bars", horizontal: true,
                 buckets: ranked.map(([t, b]) => ({ label: t, rate: b / 1e6, n: MIN_N,
                   bandLo: b / 1e6, bandHi: b / 1e6,
                   calls: ctx.sessions.reduce((n2, s) => n2 + ((s.tools || {})[t] || 0), 0) })),
                 xTitle: "megabytes returned into the conversation", highlight: 0 },
        wentWrong: `${topTool} returned ${(topBytes / 1e6).toFixed(1)} MB over ${calls} calls. Sessions that peaked above 70% of the window read a median ${fmtBytes(mh)} of tool output against ${fmtBytes(ml)} for the rest.`,
        improve: "Ask for narrow reads: search before reading, line ranges instead of whole files, and delegate broad exploration to a subagent that reports a summary rather than content.",
        promptShape: "Explore <area> with a subagent and return only: files involved (max 10), function names with line ranges, a 5-line summary. Cap command output with | tail -40.",
        howToRead: "Bars are the total bytes each tool returned into the conversation across every session in view. Bytes are roughly four to a token. Big reads are sometimes necessary; this shows where the window went, not that it was wasted.",
        confidence: `${ctx.sessions.length} sessions, ${Object.keys(totals).length} tools. ${CORRELATION}`,
        effect: Math.min(2, pct / 40), reach: 1, n: ctx.sessions.length,
      };
    },
  },
  {
    id: "cache_resets",
    title: "Idle gaps and cache resets",
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
        headline: `${totalResets} cache resets across ${withReset.length} sessions rebuilt context you had already paid for`,
        chart: { kind: "dots", rows: [
          { label: "sessions with a reset", n: withReset.length, rate: writeShare(withReset),
            bandLo: writeShare(withReset), bandHi: writeShare(withReset), accent: true },
          { label: "sessions without", n: pool.length - withReset.length,
            rate: writeShare(pool.filter((s) => !(s.cache_resets || 0))), bandLo: 0, bandHi: 0, accent: false },
        ], xTitle: "share of input tokens spent writing cache, %" },
        wentWrong: `${pctSessions.toFixed(0)}% of your busy sessions hit at least one cache reset. A reset means the cached conversation expired and the whole context was re-sent at write price rather than read price.`,
        improve: "Long thinking breaks are what expire a cache. If you must step away mid-session, finish the current step first; coming back to a cold cache costs the whole window again.",
        promptShape: "Before I step away: summarise the state to <path>/HANDOFF.md so we can resume cheaply.",
        howToRead: "A reset is counted when the tokens read from cache fall by more than half between one call and the next. The dots compare how much of each group's input spend went on writing cache rather than reading it.",
        confidence: `${pool.length} busy sessions in view. Cache lifetime depends on timing, not only on you.`,
        effect: Math.min(2, totalResets / Math.max(1, pool.length)), reach: withReset.length / pool.length, n: pool.length,
      };
    },
  },
  // --- rules that need judged sessions ------------------------------------
  {
    id: "first_prompt_score",
    title: "How complete your openers are",
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
          ? `Openers scoring 1 or less drew ${c.phrase} the hard revisions`
          : `Openers scoring 1 or less drew ${c.phrase} more hard revisions`,
        chart: { kind: "bars", buckets, xTitle: "hard revisions per 10 turns", highlight: 0 },
        wentWrong: `${low.n} sessions opened with a message the judge scored at most 1 out of 5, and ran ${low.rate.toFixed(1)} hard revisions per 10 turns against ${high.rate.toFixed(1)} for the best-scored group.`,
        improve: "Before pressing enter, check the opener names the goal, where the code lives, what works now, what done looks like, and one thing not to touch.",
        promptShape: "Goal: <one sentence>. Where: <path>. Current state: <what works / what fails>. Done when: <command and expected output>. Do not: <boundary>. Scope: only <files>.",
        howToRead: "Sessions grouped by the judge's 0-5 score for the first message, one point per rubric item present. Bar length is that group's hard corrections per 10 turns.",
        confidence: `${pool.length} judged sessions. The score reads the prompt, not the task; harder tasks attract both vaguer prompts and more corrections. ${CORRELATION}`,
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
        headline: `The judge attributed ${pct.toFixed(0)}% of your corrections to the prompt rather than the model`,
        chart: { kind: "bars", horizontal: true,
                 buckets: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({
                   label: names[k] || k, rate: v, n: MIN_N, bandLo: v, bandHi: v })),
                 xTitle: "corrective turns", highlight: 0 },
        wentWrong: `${gap} of ${attributed} attributed turns were judged as gaps in what you asked for. ${labelled - attributed} corrective turns carried no attribution.`,
        improve: "Treat every prompt-gap correction as a missing line in your opener. Keep a short standing preamble and paste it at the top of each new session.",
        promptShape: "Standing rules: <rule 1>; <rule 2>; <rule 3>. Task: <goal>. Where: <path>. Done when: <check>. If anything is ambiguous, ask before editing.",
        howToRead: "Bars count corrective turns by the cause the judge assigned. Cause labels are one model's judgement per turn and tend to over-attribute to prompts, so read the ordering rather than the exact counts.",
        confidence: `${attributed} attributed turns across ${ctx.judged.length} judged sessions.`,
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
                     "constraints", "current state", "scope bound", "priority"];
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
        headline: `Openers missing ${top.item} ran ${top.gap.toFixed(1)} more hard revisions per 10 turns`,
        chart: { kind: "dumbbell", rows: rows.map((r) => ({
          label: `${r.item} (left out in ${r.pct.toFixed(0)}%)`, a: r.b.rate, b: r.a.rate })),
          xTitle: "hard revisions per 10 turns" },
        wentWrong: `In ${top.pct.toFixed(0)}% of judged sessions the opener left out ${top.item}. Those ran ${top.a.rate.toFixed(1)} hard revisions per 10 turns against ${top.b.rate.toFixed(1)} when it was present.`,
        improve: `Add ${top.item} to every opener this week. Say what already works and what was tried, and what form the answer should take.`,
        promptShape: "Goal: <one sentence>. Current state: <what exists / what was tried>. Files: <paths>. Output: <a PR / a file / a table / an answer>. Check: <how we know it worked>.",
        howToRead: "Each row is one ingredient the judge checks. The grey dot is the correction rate when your opener included it, the blue dot when it did not, and the connector is the gap between them.",
        confidence: `${ctx.judged.length} judged sessions. This is the largest of ${rows.length} comparisons, so the top row is the least certain; the ordering matters more than the number. ${CORRELATION}`,
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
  if (comps.length < 8) {
    verdict = "not enough compactions to judge";
    detail = `${comps.length} compactions so far. This card needs 8 before it draws a conclusion.`;
  } else if (canCompareLoss && rateAfter >= rateBase * 1.5 && rateAfter >= MIN_LOSS_RATE) {
    verdict = "lossy";
    detail = `After a compaction you repeated earlier wording in ${rateAfter.toFixed(1)}% of turns against ${rateBase.toFixed(1)}% otherwise.`;
  } else if (autoPct >= 70 || medPre >= 850000) {
    verdict = "forced late";
    detail = `${autoPct.toFixed(0)}% of your compactions fired automatically, at a median ${(medPre / 1000).toFixed(0)}K tokens, dropping ${medDrop.toFixed(0)}% of the context in one step.`;
  } else if (per100 > 3) {
    verdict = "often";
    detail = `${per100.toFixed(1)} compactions per 100 turns is frequent enough to be worth pacing.`;
  } else {
    verdict = "by choice";
    detail = `${(100 - autoPct).toFixed(0)}% of your compactions were manual and the ones after them show no excess repetition.`;
  }

  return {
    verdict, detail, count: comps.length, per100, autoPct, medPre, medDrop,
    ranHot, sessionsWith: withC.length,
    loss: canCompareLoss ? { rateAfter, rateBase, after, events: afterRe }
                         : { tooFew: true, after, events: afterRe },
    points: comps,
    improve: verdict === "forced late"
      ? "Compact on your own terms at a task boundary, around 60 to 75% of the window, after asking for a handoff note saved to a file. A forced compaction at the ceiling drops almost everything at once."
      : "Keep compacting at task boundaries rather than waiting for the ceiling.",
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
  if (!sessions.length) return "No sessions in this period yet.";
  const clean = share(sessions, noVisibleCorrection);
  const parts = [];
  parts.push(`${sessions.length} sessions in view. ${clean.pct.toFixed(0)}% finished with no visible correction.`);
  if (extra.judged) parts.push(`${extra.judged} were judged.`);
  if (!findings.length) {
    parts.push("Nothing stands out yet; the checks below unlock as more sessions land.");
    return parts.join(" ");
  }
  parts.push(`Biggest lever: ${findings[0].headline.toLowerCase()}.`);
  if (findings[1]) parts.push(`Next: ${findings[1].headline.toLowerCase()}.`);
  parts.push(`One change for tomorrow: ${findings[0].improve.split(". ")[0].replace(/\.$/, "")}.`);
  return parts.join(" ");
}
