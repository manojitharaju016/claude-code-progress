// metrics.js — the Prompting view.
//
// Fetches the metrics feed, runs the rules over whatever the filters leave, and
// renders one card per finding. Every card has the same anatomy so the reader
// learns it once: the finding, the chart, what went wrong, what to do instead, a
// prompt shape to copy, how to read the chart, and how sure it is.
//
// Charts are Plotly, loaded lazily. Every one of them has a table twin, which is
// also what appears if the CDN is blocked - a chart that will not load must not
// take the numbers with it.

"use strict";

import * as I from "./insights.js";
import { loadPlotly, watchResize } from "./plotly-loader.js";
import { tokens, figureFor, tableFor, CONFIG } from "./plotly-theme.js";
import { revealOnScroll, markReveal, toggleHeight, tweenNumber, reduced } from "./motion.js";

const PERIODS = [["7d", 7], ["30d", 30], ["90d", 90], ["all", null]];
const REFRESH_MS = 5 * 60 * 1000;

const state = {
  feed: null, pricing: null, loaded: false, plotly: null, plotlyError: null,
  period: 30, machines: new Set(), includeResumed: false, drill: null,
  sort: { key: "latest_ts", dir: -1 }, open: new Set(), etag: null, timer: null,
};
const charts = [];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;      // textContent everywhere: feed data is data
  return n;
};

// ------------------------------------------------------------------ loading

export async function openPrompting() {
  if (!state.loaded) {
    state.loaded = true;
    await Promise.all([fetchFeed(), fetchPricing()]);
    render();
    loadPlotly().then((P) => { state.plotly = P; drawCharts(); })
      .catch((err) => { state.plotlyError = err.message; render(); });
  }
  if (!state.timer) state.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
}

export function closePrompting() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

async function fetchPricing() {
  try { state.pricing = await (await fetch("./pricing.json")).json(); } catch (_) { state.pricing = null; }
}

async function fetchFeed() {
  const headers = state.etag ? { "If-None-Match": state.etag } : {};
  let res;
  try {
    res = await fetch("/api/metrics", { headers });
  } catch (_) {
    try { res = await fetch("./metrics.json"); } catch (e2) { return showError(e2.message); }
  }
  if (res.status === 304) return;
  if (!res.ok) {
    if (res.status === 404) {
      try { res = await fetch("./metrics.json"); } catch (e) { return showError(e.message); }
      if (!res.ok) return showError("no metrics feed yet");
    } else {
      return showError("the feed could not be read (" + res.status + ")");
    }
  }
  state.etag = res.headers.get("ETag");
  const feed = await res.json();
  if (feed && feed.error) return showError(feed.detail || feed.error);
  state.feed = normalise(feed);
  $("m-error").hidden = true;
}

/** Accept either the merged Worker shape or a single machine's file. */
function normalise(feed) {
  if (Array.isArray(feed.machines)) return feed;
  return {
    generated_utc: feed.generated_utc,
    machines: [{ name: feed.machine, reader_version: feed.reader_version,
                 generated_utc: feed.generated_utc, excerpts_published: feed.excerpts_published }],
    skipped: [], sessions: (feed.sessions || []).map((s) => ({ ...s, machine: feed.machine })),
    judged: feed.judged || 0, judge_tokens: feed.judge_tokens || 0,
    coach: feed.coach || null, lifetime: feed.lifetime || { sessions: 0, by_model: {} },
  };
}

async function refresh() { await fetchFeed(); render(); drawCharts(); }

function showError(msg) {
  const box = $("m-error");
  box.hidden = false;
  box.textContent = "";
  box.append(el("p", null, "Could not load your sessions: " + msg + "."));
}

// ------------------------------------------------------------- the filters

function inPeriod(s) {
  if (!state.period) return true;
  const cutoff = Date.now() - state.period * 86400000;
  return new Date(s.latest_ts || 0).getTime() >= cutoff;
}

function visibleSessions() {
  const f = state.feed;
  if (!f) return [];
  return f.sessions.filter((s) =>
    s.kind !== "judge" &&
    inPeriod(s) &&
    (!state.machines.size || state.machines.has(s.machine)) &&
    (state.includeResumed || !s.resumed_from) &&
    (!state.drill || state.drill.has(s.sid)));
}

// ------------------------------------------------------------------ render

function render() {
  const f = state.feed;
  if (!f) return;
  renderFilters();
  const sessions = visibleSessions();
  const { findings, locked, judged } = I.runRules(sessions, { pricing: state.pricing });
  renderReport(sessions, findings, judged);
  renderGlance(sessions, judged);
  renderInsights(findings, locked);
  renderCompaction(sessions);
  renderTokens(sessions);
  renderTable(sessions);
  revealOnScroll();
}

function renderFilters() {
  const per = $("m-period");
  if (!per.children.length) {
    for (const [label, days] of PERIODS) {
      const b = el("button", "chip-btn", label === "all" ? "all time" : "last " + label);
      b.setAttribute("aria-pressed", String(state.period === days));
      b.onclick = () => { state.period = days; render(); drawCharts(); };
      per.appendChild(b);
    }
    const mm = $("m-machines");
    for (const m of state.feed.machines) {
      const b = el("button", "chip-btn", m.name + (m.reader_version ? " " + m.reader_version : ""));
      b.setAttribute("aria-pressed", "false");
      b.title = "Version " + (m.reader_version || "unknown") +
                (m.excerpts_published ? ". The opening of each first message is shown." : ". No prompt text leaves this machine.");
      b.onclick = () => {
        state.machines.has(m.name) ? state.machines.delete(m.name) : state.machines.add(m.name);
        render(); drawCharts();
      };
      mm.appendChild(b);
    }
    for (const sk of state.feed.skipped || []) {
      const s = el("span", "chip-btn", sk.name + " (needs updating)");
      s.title = "This machine is running an older reader, so its sessions are not shown.";
      mm.appendChild(s);
    }
    const extra = $("m-extra");
    const r = el("button", "chip-btn", "include carried-on sessions");
    r.setAttribute("aria-pressed", "false");
    r.title = "A resumed session continues an earlier one, so its first message is not a fresh first message.";
    r.onclick = () => { state.includeResumed = !state.includeResumed; render(); drawCharts(); };
    extra.appendChild(r);
    $("m-drill-clear").onclick = () => { state.drill = null; render(); drawCharts(); };
  }
  [...$("m-period").children].forEach((b, i) =>
    b.setAttribute("aria-pressed", String(state.period === PERIODS[i][1])));
  [...$("m-machines").children].forEach((b) => {
    if (b.tagName === "BUTTON") b.setAttribute("aria-pressed", String(state.machines.has(b.textContent.split(" ")[0])));
  });
  const ex = $("m-extra").firstChild;
  if (ex) ex.setAttribute("aria-pressed", String(state.includeResumed));
  $("m-drill").hidden = !state.drill;
  $("m-drill-clear").hidden = !state.drill;
  if (state.drill) $("m-drill").textContent = "narrowed to " + state.drill.size + " sessions";
}

function renderReport(sessions, findings, judged) {
  const p = $("report");
  p.textContent = "";
  p.append(el("span", "lead", I.report(sessions, findings, { judged })));
  const c = state.feed.coach;
  if (c && c.notes && c.notes.length) {
    const note = el("p", null, "From your last review (" + c.date + "): " + c.notes[0].pattern + ". " + c.notes[0].advice);
    note.style.fontSize = "15px";
    note.style.color = "var(--text-2)";
    p.appendChild(note);
  }
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(Math.round(n));
}

function figure(value, label, note, accent) {
  const f = el("div", "figure");
  const v = el("div", "figure-value" + (accent ? " accent" : ""));
  v.textContent = value;
  f.append(v, el("div", "figure-label", label), el("div", "figure-note", note));
  return f;
}

function renderGlance(sessions, judged) {
  const g = $("m-glance");
  g.textContent = "";
  if (!sessions.length) {
    g.append(el("p", "notice", "Nothing recorded in this period."));
    return;
  }
  const clean = I.share(sessions, I.noVisibleCorrection);
  const hardTotal = sessions.reduce((n, s) => n + I.hard(s), 0);
  const steer = sessions.reduce((n, s) => n + I.steering(s), 0);
  const turns = sessions.reduce((n, s) => n + (s.human_turns || 0), 0);
  const tokens = sessions.reduce((n, s) => n + I.tokensOf(s), 0);
  let usd = 0, unpriced = 0;
  for (const s of sessions) { const c = I.costOf(s, state.pricing); usd += c.usd; unpriced += c.unpriced; }
  const resets = sessions.reduce((n, s) => n + (s.cache_resets || 0), 0);

  g.append(
    figure(clean.pct.toFixed(0) + "%", "ran without a correction",
           "you never interrupted it, turned down an edit, or told it to back up", true),
    figure(((hardTotal / Math.max(1, turns)) * 10).toFixed(1), "corrections per 10 messages",
           hardTotal + " times across " + turns + " messages you sent"),
    figure(((steer / Math.max(1, turns)) * 10).toFixed(1), "messages sent mid-run",
           "you added something while Claude was still working"),
    figure(fmtTokens(tokens / Math.max(1, sessions.length)), "tokens a session",
           "$" + (usd / Math.max(1, sessions.length)).toFixed(2) + " a session at published prices" +
           (unpriced ? " (" + unpriced + " calls unpriced)" : "")),
    figure(String(resets), "conversations re-sent",
           "Claude's saved copy expired and everything went again"),
    figure(String(judged), "sessions reviewed",
           judged ? "reviewed, so the rest of the findings can appear" : "run /judge-sessions to unlock the rest"),
  );
  [...g.children].forEach(markReveal);
}

// -------------------------------------------------------------- the cards

function card(cls) {
  const c = el("div", cls || "insight");
  markReveal(c);
  return c;
}

function proseBlock(finding) {
  const box = el("div", "prose");
  box.append(el("p", null, finding.wentWrong));
  const imp = el("div", "improve");
  imp.append(el("span", "k", "What to try instead"), el("span", null, finding.improve));
  const shape = el("code", "shape", finding.promptShape);
  imp.append(shape);
  const copy = el("button", "copy-btn", "Copy this");
  copy.onclick = () => {
    navigator.clipboard && navigator.clipboard.writeText(finding.promptShape);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy this"), 1600);
  };
  imp.append(copy);
  box.append(imp);
  const how = el("details", "how");
  how.append(el("summary", null, ""), el("p", null, finding.howToRead));
  box.append(how);
  box.append(el("p", "confidence", finding.confidence));
  return box;
}

function chartBlock(chart, caption) {
  const wrap = el("div");
  const host = el("div", "chart");
  host.setAttribute("role", "figure");
  host.setAttribute("aria-label", caption);
  wrap.append(host);
  const table = tableFor(chart, caption);
  table.hidden = true;
  const toggle = el("button", "copy-btn", "Show the numbers");
  toggle.onclick = () => {
    const showing = !table.hidden;
    table.hidden = showing;
    host.hidden = !showing;
    toggle.textContent = showing ? "Show the numbers" : "View as chart";
  };
  wrap.append(table, toggle);
  if (state.plotlyError) {
    host.hidden = true;
    table.hidden = false;
    toggle.textContent = "Show the chart";
    wrap.insertBefore(el("div", "notice", "The charts could not load: " + state.plotlyError +
      ". Everything they would show is in the numbers below."), host);
  } else {
    charts.push({ host, chart });
  }
  return wrap;
}

function renderInsights(findings, locked) {
  const box = $("m-insights");
  box.textContent = "";
  charts.length = 0;
  if (!findings.length) {
    box.append(el("div", "notice", "Nothing stands out over this period. More sessions will unlock the checks listed below."));
  }
  findings.forEach((f, i) => {
    const c = card();
    c.append(el("div", "insight-rank", "Finding " + (i + 1) + " of " + findings.length));
    c.append(el("h3", null, f.headline));
    c.append(el("div", "insight-caption", captionFor(f)));
    if (f.chart) c.append(chartBlock(f.chart, captionFor(f)));
    c.append(proseBlock(f));
    box.append(c);
  });
  const lockedCard = $("m-locked-card");
  const list = $("m-locked");
  list.textContent = "";
  if (locked.length) {
    lockedCard.hidden = false;
    for (const l of locked) {
      const li = el("li");
      li.append(el("span", "t", l.title + " — "), el("span", null, l.reason));
      list.append(li);
    }
  } else {
    lockedCard.hidden = true;
  }
}

function captionFor(f) {
  return f.chart && f.chart.xTitle ? "Measured in " + f.chart.xTitle + "." : f.title;
}

function renderCompaction(sessions) {
  const box = $("m-compaction");
  box.textContent = "";
  const v = I.compactionVerdict(sessions);
  const c = card();
  const pillClass = v.verdict === "by choice" ? "good"
    : (v.verdict === "not enough compactions to judge" ? "none" : "warn");
  c.append(el("span", "verdict-pill " + pillClass, v.verdict));
  c.append(el("h3", null, verdictHeadline(v)));
  c.append(el("div", "insight-caption", v.detail));

  if (v.count) {
    const chart = { kind: "compaction", points: v.points, window: 1000000 };
    c.append(chartBlock(chart, "Every compaction: how far into the session, and how full the context was."));
  }
  const box2 = el("div", "prose");
  const loss = v.loss && v.loss.tooFew
    ? "There is not enough here to say whether compacting loses anything: " + v.loss.events +
      " repeated messages out of " + v.loss.after + " is too few to compare."
    : (v.loss ? "After compacting, " + v.loss.rateAfter.toFixed(1) + "% of your messages repeated something you had already said, against " +
                v.loss.rateBase.toFixed(1) + "% the rest of the time." : "");
  if (loss) box2.append(el("p", null, loss));
  if (v.ranHot) {
    box2.append(el("p", null, v.ranHot + " sessions filled more than 80% of the context window and never compacted at all."));
  }
  const imp = el("div", "improve");
  imp.append(el("span", "k", "What to try instead"), el("span", null, v.improve),
             el("code", "shape", v.promptShape));
  box2.append(imp);
  const how = el("details", "how");
  how.append(el("summary", null, ""), el("p", null, v.howToRead));
  box2.append(how);
  box2.append(el("p", "confidence",
    v.count + " compactions across " + v.sessionsWith + " sessions. Repeated wording is spotted by matching text, " +
    "not by understanding it, and a long session needs more restating anyway."));
  c.append(box2);
  box.append(c);
}

function verdictHeadline(v) {
  switch (v.verdict) {
    case "forced late": return "Your compactions are firing at the ceiling, not at a boundary";
    case "left too late": return "Your sessions run to the ceiling without compacting";
    case "lossy": return "You retype context after compacting";
    case "often": return "You compact often enough that it is worth pacing";
    case "by choice": return "You compact on your own terms";
    default: return "Not enough compactions to judge yet";
  }
}

function renderTokens(sessions) {
  const box = $("m-tokens");
  box.textContent = "";
  if (!sessions.length) return;
  const byModel = {};
  for (const s of sessions) {
    for (const [m, b] of Object.entries(s.by_model || {})) {
      const d = byModel[m] || (byModel[m] = { in: 0, cc: 0, cr: 0, out: 0, think: 0, calls: 0 });
      d.in += b.in || 0; d.cc += (b.cc5 || 0) + (b.cc1h || 0); d.cr += b.cr || 0;
      d.out += b.out || 0; d.think += b.think || 0; d.calls += b.calls || 0;
    }
  }
  const rows = Object.entries(byModel)
    .map(([m, b]) => ({ label: m, rate: (b.in + b.cc + b.cr + b.out) / 1e6, n: b.calls,
                        bandLo: (b.in + b.cc + b.cr + b.out) / 1e6, bandHi: (b.in + b.cc + b.cr + b.out) / 1e6 }))
    .sort((a, b) => b.rate - a.rate);
  const c = card();
  let usd = 0, unpriced = 0;
  for (const s of sessions) { const r = I.costOf(s, state.pricing); usd += r.usd; unpriced += r.unpriced; }
  c.append(el("h3", null, "$" + usd.toFixed(0) + " at published prices across " + sessions.length + " sessions"));
  c.append(el("div", "insight-caption",
    "What these sessions would have cost if you were paying per token" +
    (unpriced ? ", not counting " + unpriced + " calls on models with no published price" : "") +
    ". Your subscription pays none of this. It is here so you can compare one session with another."));
  c.append(chartBlock({ kind: "bars", buckets: rows, xTitle: "million tokens", highlight: 0 },
                      "Total tokens by model."));
  const think = Object.values(byModel).reduce((n, b) => n + b.think, 0);
  const out = Object.values(byModel).reduce((n, b) => n + b.out, 0);
  const cc = Object.values(byModel).reduce((n, b) => n + b.cc, 0);
  const cr = Object.values(byModel).reduce((n, b) => n + b.cr, 0);
  const p = el("div", "prose");
  p.append(el("p", null,
    "Thinking made up " + ((think / Math.max(1, out)) * 100).toFixed(0) + "% of what Claude wrote. " +
    "Making new saved copies of the conversation took " + ((cc / Math.max(1, cc + cr)) * 100).toFixed(0) +
    "% of the cached input, and every expiry pushes that up, because the whole thing has to be saved again."));
  const how = el("details", "how");
  how.append(el("summary", null, ""), el("p", null,
    "Everything that passed through each model across the sessions shown: what you sent, what was saved and " +
    "re-read, and what came back. Hover a bar for the number of calls."));
  p.append(how);
  c.append(p);
  box.append(c);
}

// -------------------------------------------------------------- the table

const COLUMNS = [
  { key: "latest_ts", label: "when", fmt: (s) => (s.latest_ts || "").slice(0, 10), cls: "t" },
  { key: "title", label: "project", fmt: (s) => projName(s), cls: "t" },
  { key: "machine", label: "machine", fmt: (s) => s.machine || "", cls: "t" },
  { key: "human_turns", label: "turns", num: true },
  { key: "hard", label: "hard", num: true, get: I.hard, title: "times you interrupted, turned down an edit, or turned down a plan" },
  { key: "steering", label: "mid-turn", num: true, get: I.steering },
  { key: "lex_corrections", label: "maybe", num: true, title: "replies that read like a correction" },
  { key: "score", label: "first message", num: true, get: (s) => (s.j ? s.j.score : null), title: "how complete your first message was, out of 5" },
  { key: "tokens", label: "tokens", num: true, get: I.tokensOf, fmt: (s) => fmtTokens(I.tokensOf(s)) },
  { key: "ctx", label: "peak ctx", num: true, get: I.ctxPct, fmt: (s) => I.ctxPct(s).toFixed(0) + "%" },
  { key: "comp", label: "compactions", num: true, get: (s) => (s.compactions || []).length },
  { key: "outcome", label: "outcome", fmt: (s) => (s.j ? s.j.outcome : ""), cls: "t" },
];

function projName(s) {
  const parts = (s.cwd || "").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || s.cwd || "";
}

function renderTable(sessions) {
  const box = $("m-table");
  box.textContent = "";
  if (!sessions.length) { box.append(el("div", "notice", "Nothing recorded in this period.")); return; }
  const tbl = el("table", "stable");
  const head = el("tr");
  for (const c of COLUMNS) {
    const th = el("th", null, c.label + (state.sort.key === c.key ? (state.sort.dir < 0 ? " ↓" : " ↑") : ""));
    if (c.title) th.title = c.title;
    th.onclick = () => {
      state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : -1 };
      renderTable(sessions);
    };
    head.appendChild(th);
  }
  tbl.appendChild(head);

  const col = COLUMNS.find((c) => c.key === state.sort.key) || COLUMNS[0];
  const val = (s) => (col.get ? col.get(s) : s[col.key]);
  const sorted = [...sessions].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * state.sort.dir;
  });

  const body = el("tbody");
  for (const s of sorted.slice(0, 200)) {
    const tr = el("tr");
    for (const c of COLUMNS) {
      const raw = c.get ? c.get(s) : s[c.key];
      const td = el("td", (c.cls || "") + (c.num ? " num" : ""),
                    c.fmt ? c.fmt(s) : (raw == null ? "" : String(raw)));
      tr.appendChild(td);
    }
    tr.onclick = () => toggleDetail(s, tr, body);
    body.appendChild(tr);
  }
  tbl.appendChild(body);
  box.append(tbl);
  if (sorted.length > 200) {
    box.append(el("p", "confidence", "Showing the 200 most recent of " + sorted.length + " sessions."));
  }
}

function toggleDetail(s, tr, body) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("detail")) { next.remove(); return; }
  const row = el("tr", "detail");
  const td = el("td");
  td.colSpan = COLUMNS.length;
  const inner = el("div", "detail-inner");

  const head = el("div");
  head.append(el("h3", null, projName(s) + " · " + (s.latest_ts || "").slice(0, 10)));
  const bits = [
    s.human_turns + " of your messages",
    (s.tool_calls_total || 0) + " tool calls",
    Math.round(s.active_min || 0) + " min active",
    Math.round(I.tokensOf(s) / 1000) + "K tokens",
    "$" + I.costOf(s, state.pricing).usd.toFixed(2) + " list price",
  ];
  head.append(el("div", "insight-caption", bits.join(" · ")));
  inner.append(head);

  if (s.j) {
    const j = s.j;
    inner.append(el("p", null, "Your first message scored " + j.score + " out of 5, and the session ended " + j.outcome + ". " + (j.summary || "")));
    if (j.missing && j.missing.length) {
      inner.append(el("p", "confidence", "Your first message did not mention: " + j.missing.join(", ") + "."));
    }
  } else {
    inner.append(el("p", "confidence", "Not reviewed yet. Run /judge-sessions and this session gets a read-through."));
  }
  if (s.fp_excerpt) {
    inner.append(el("code", "shape", s.fp_excerpt));
  }

  const sig = [];
  if (s.interrupts) sig.push(s.interrupts + " interruptions");
  if (s.denied_user) sig.push(s.denied_user + " actions you turned down");
  if (s.denied_plan) sig.push(s.denied_plan + " plans you turned down");
  if (s.steering) sig.push(s.steering + " messages while it was working");
  if (s.lex_corrections) sig.push(s.lex_corrections + " replies that read like a correction");
  if (s.reexplain) sig.push(s.reexplain + " messages repeating something earlier");
  inner.append(el("p", null, sig.length ? "What happened: " + sig.join(", ") + "." : "Nothing went wrong in this one."));

  if ((s.ctx_series || []).length > 1) {
    inner.append(sparkline(s));
    inner.append(el("p", "confidence",
      "How full the context got as the session went on" +
      ((s.compactions || []).length ? ". The upright marks are compactions." : ".")));
  }
  td.append(inner);
  row.append(td);
  body.insertBefore(row, tr.nextSibling);
}

/** A small inline sparkline: dozens of Plotly instances would be far too heavy. */
function sparkline(s) {
  const W = 560, H = 90, pad = 4;
  const pts = s.ctx_series || [];
  const maxT = Math.max(...pts.map((p) => p[0]), 1);
  const win = s.ctx_window || 1000000;
  const x = (t) => pad + (t / maxT) * (W - pad * 2);
  const y = (c) => H - pad - Math.min(1, c / win) * (H - pad * 2);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label",
    "Context grew to " + Math.round(I.ctxPct(s)) + "% of the model window.");
  const mk = (tag, attrs) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  svg.append(mk("line", { x1: pad, x2: W - pad, y1: y(win * 0.8), y2: y(win * 0.8),
                          stroke: "var(--rule)", "stroke-dasharray": "3 3" }));
  svg.append(mk("polyline", {
    points: pts.map((p) => x(p[0]) + "," + y(p[1])).join(" "),
    fill: "none", stroke: "var(--accent)", "stroke-width": "2",
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }));
  for (const c of s.compactions || []) {
    svg.append(mk("line", { x1: x(c.at_min || 0), x2: x(c.at_min || 0), y1: pad, y2: H - pad,
                            stroke: "var(--amber)", "stroke-width": "1.5" }));
  }
  return svg;
}

// -------------------------------------------------------------- the charts

export function drawCharts() {
  if (!state.plotly) return;
  const t = tokens();
  for (const c of charts) {
    if (!c.host.isConnected || c.host.hidden) continue;
    const fig = figureFor(c.chart, t);
    if (!fig) continue;
    state.plotly.react(c.host, fig.data, fig.layout, CONFIG);
    if (!c.watched) { watchResize(c.host, state.plotly); c.watched = true; }
  }
}

/** A theme change repaints trace colours, which a template alone would not. */
export function repaintCharts() { drawCharts(); }
