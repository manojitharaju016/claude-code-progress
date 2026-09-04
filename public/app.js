/* Claude Code — Mission Control front-end (vanilla JS, no framework).
   Data comes pre-merged from the Worker's /api/data (auto progress + overlay).
   Edits POST to /api/save, which writes only the overlay file in the repo. */

"use strict";

import { navShadow, moveThumb, revealOnScroll, markReveal } from "./motion.js";
import { openPrompting, closePrompting, repaintCharts } from "./metrics.js";

const DATA_URL = "/api/data";
const SAVE_URL = "/api/save";
const FALLBACK_URL = "./data.json"; // local preview without a Worker
const POLL_MS = 20000;

const expanded = new Set(JSON.parse(localStorage.getItem("cc_expanded") || "[]"));
let lastTree = null;
let filter = "all";
let query = "";
let machineFilter = "all";
let pollTimer = null;
let multiMachine = false;

// A live search auto-opens matching rows. These two sets make that state explicit so
// clicking a search-opened row can still CLOSE it (it used to be forced back open).
const queryOpenKeys = new Set();   // rows the current search wants open
const collapsedByUser = new Set(); // rows the user explicitly closed during a search

function isRowOpen(key) {
  if (expanded.has(key)) return true;
  return !!query && queryOpenKeys.has(key) && !collapsedByUser.has(key);
}
function setRowOpen(key, open) {
  if (open) { expanded.add(key); collapsedByUser.delete(key); }
  else { expanded.delete(key); if (query && queryOpenKeys.has(key)) collapsedByUser.add(key); }
  saveExpanded();
}

// stable accent hue per machine (categorical palette; used ONLY for the machine
// accent/dot, never for progress meters — those stay blue/green per dataviz).
const MACHINE_HUES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#e66767"];
function machineHue(name, machines) {
  const i = Math.max(0, machines.indexOf(name));
  return MACHINE_HUES[i % MACHINE_HUES.length];
}
// Cosmetic only, not a config point — pick whatever icon rule suits your own
// machine names.
function machineIcon(name) {
  const n = (name || "").toLowerCase();
  return (n === "mac" || n.includes("mac") || n.includes("book")) ? "🍎" : "🖥";
}

// ---- tiny helpers -----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const pct = (v) => (v == null ? "—" : Math.round(v) + "%");
const saveExpanded = () => localStorage.setItem("cc_expanded", JSON.stringify([...expanded]));

function relTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso); if (isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 8) return "just now";
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return Math.floor(s / 604800) + "w ago";
}
function fmtDur(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s < 90) return Math.round(s) + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  if (s < 172800) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + "h";
  return Math.round(s / 86400) + "d";
}

// A self-updating time span. kind: 'rel' (x ago), 'elapsed' (running duration),
// 'dur' (span between two fixed times). refreshTimes() rewrites them each second.
function timeEl(kind, ts, end) {
  const e = el("span", "time");
  e.dataset.kind = kind;
  if (ts) e.dataset.ts = ts;
  if (end) e.dataset.end = end;
  paintTime(e);
  return e;
}
function paintTime(e) {
  const k = e.dataset.kind, ts = e.dataset.ts, end = e.dataset.end;
  if (k === "rel") { e.textContent = relTime(ts); return; }
  if (k === "elapsed") {
    const t = Date.parse(ts); if (isNaN(t)) { e.textContent = ""; return; }
    e.textContent = fmtDur(Date.now() - t);
    return;
  }
  if (k === "dur") {
    const a = Date.parse(ts), b = Date.parse(end);
    e.textContent = (isNaN(a) || isNaN(b)) ? "" : fmtDur(b - a);
  }
}
function refreshTimes() { for (const e of document.querySelectorAll(".time")) paintTime(e); }

const STATUS = {
  completed:   { ic: "✓", label: "done" },
  in_progress: { ic: "◐", label: "in progress" },
  pending:     { ic: "○", label: "to do" },
};

// ---- data fetch -------------------------------------------------------------
async function fetchData() {
  try {
    const res = await fetch(DATA_URL, { credentials: "same-origin", cache: "no-store" });
    if (res.status === 401) { showError("Not signed in. Reload the page and enter the site password."); return null; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    try { const r = await fetch(FALLBACK_URL, { cache: "no-store" }); if (r.ok) return await r.json(); } catch (_) {}
    showError("Could not refresh (" + e.message + ") — still showing the last loaded view. Will retry automatically.");
    return null;
  }
}

// ---- filter / search model --------------------------------------------------
function matches(text) { return !query || (text || "").toLowerCase().includes(query); }

function stageState(s) {
  if (s.running) return "live";
  if (s.progress === 100) return "done";
  if ((s.subtasks || []).some((t) => t.status === "in_progress") || (s.progress != null && s.progress > 0)) return "doing";
  return "other";
}

// How many sessions in this project are running AND not hidden. The reader's
// num_active counts hidden ones, which made badges contradict the tiles.
function liveCount(p) {
  if (typeof p._active === "number") return p._active;
  return (p.stages || []).filter((s) => s.running && !s.hidden).length;
}

// A project is "active" if any stage is running or partially done; else "done/idle".
function projActive(p) {
  return (p.stages || []).some((s) => s.running || (s.progress != null && s.progress < 100));
}

function buildView(tree) {
  const showHidden = filter === "hidden";
  const view = [];
  for (const p of tree.projects || []) {
    const pHidden = !!p.hidden;
    const stages = [];
    for (const s of p.stages || []) {
      const sHidden = !!s.hidden;
      const subHidden = (s.subtasks || []).some((t) => t.hidden);
      const hiddenGate = showHidden ? (pHidden || sHidden || subHidden) : (!pHidden && !sHidden);
      if (!hiddenGate) continue;
      if (!showHidden && filter !== "all") {
        const st = stageState(s);
        if (filter === "live" && st !== "live") continue;
        if (filter === "doing" && st !== "doing" && st !== "live") continue;
        if (filter === "done" && st !== "done") continue;
      }
      const subMatch = (s.subtasks || []).some((t) => matches(t.text));
      if (query && !matches(s.title) && !subMatch && !matches(p.name)) continue;
      stages.push(Object.assign({}, s, { _subMatch: query ? subMatch : false }));
    }
    if (machineFilter !== "all" && p.machine !== machineFilter) continue;
    if (stages.length === 0 && !(showHidden && pHidden)) continue;
    view.push(Object.assign({}, p, { stages, _hiddenSelf: pHidden, _active: liveCount(p) }));
  }
  return view;
}

// ---- render -----------------------------------------------------------------
function render(tree) {
  lastTree = tree;
  clearError();
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("title-input")) return;

  const visible = (tree.projects || []).filter((p) => !p.hidden);
  multiMachine = new Set((tree.projects || []).map((p) => p.machine)).size > 1;

  // top strip
  let totDone = 0, totTasks = 0, liveStages = 0, visStages = 0;
  for (const p of visible) for (const s of p.stages || []) {
    if (s.hidden) continue;
    visStages++; totDone += s.num_done || 0; totTasks += s.num_todos || 0;
    if (s.running) liveStages++;
  }
  const overall = totTasks ? (100 * totDone / totTasks) : null;
  $("#hero-pct").textContent = pct(overall);
  $("#hero-sub").textContent = totTasks ? (totDone + " of " + totTasks + " to-dos done") : "no to-dos yet";
  const hf = $("#hero-fill");
  hf.style.width = (overall == null ? 0 : Math.max(0, Math.min(100, overall))) + "%";
  hf.classList.toggle("done", overall >= 100);
  $("#kpi-projects").textContent = visible.length;
  $("#kpi-live").textContent = liveStages;
  $("#kpi-stages").textContent = visStages;
  $("#kpi-machines").textContent = new Set(visible.map((p) => p.machine)).size;
  $("#machine-chip").textContent = tree.machine || "?";

  renderLiveNow(tree, visible);
  renderTabsCounts(tree);
  renderMachineSwitcher(tree);
  tickStatus();

  // panels + sections
  const wrap = $("#panels");
  wrap.replaceChildren();
  const view = buildView(tree);
  const base = visible.filter((p) => machineFilter === "all" || p.machine === machineFilter);
  const M = (filter === "hidden")
    ? (tree.projects || []).filter((p) => p.hidden || (p.stages || []).some((s) => s.hidden || (s.subtasks || []).some((t) => t.hidden))).length
    : base.length;

  // "showing N of M" bar
  const bar = el("div", "showing");
  const filtered = filter !== "all" || !!query || machineFilter !== "all";
  bar.appendChild(el("span", null, "Showing " + view.length + " of " + M + " project" + (M === 1 ? "" : "s")));
  if (filtered) {
    const tags = [];
    if (machineFilter !== "all") tags.push(machineIcon(machineFilter) + " " + machineFilter);
    if (filter !== "all") tags.push(labelFor(filter));
    if (query) tags.push('“' + query + '”');
    bar.appendChild(el("span", "showing-tag", tags.join(" · ")));
    const clear = el("button", "showing-clear", "show all");
    clear.addEventListener("click", resetFilters);
    bar.appendChild(clear);
  }
  wrap.appendChild(bar);

  if (view.length === 0) { $("#empty").hidden = false; return; }
  $("#empty").hidden = true;

  if (filter === "hidden") {
    for (const p of view) wrap.appendChild(renderProject(p));
  } else if (machineFilter === "all" && multiMachine) {
    // group into a separated panel per machine
    const machines = [...new Set((tree.projects || []).map((p) => p.machine))];
    const byMachine = new Map();
    for (const p of view) { if (!byMachine.has(p.machine)) byMachine.set(p.machine, []); byMachine.get(p.machine).push(p); }
    // order machines: those with live work first, else by most-recent activity
    const order = [...byMachine.keys()].sort((a, b) => machineScore(byMachine.get(b)) - machineScore(byMachine.get(a)));
    for (const mname of order) wrap.appendChild(renderMachinePanel(mname, byMachine.get(mname), machines));
  } else {
    // single machine (or only one exists) -> Active/Done sections
    for (const node of activeDoneSections(view)) wrap.appendChild(node);
  }
  refreshTimes();
}

function machineScore(projects) {
  const live = projects.reduce((n, p) => n + liveCount(p), 0);
  const last = projects.reduce((m, p) => (p.last_ts && p.last_ts > m ? p.last_ts : m), "");
  return live * 1e13 + (last ? Date.parse(last) : 0);
}

function activeDoneSections(view) {
  const out = [];
  const activeP = view.filter(projActive);
  const doneP = view.filter((p) => !projActive(p));
  if (activeP.length) { out.push(sectionHead("Active work", activeP.length, "●")); for (const p of activeP) out.push(renderProject(p)); }
  if (doneP.length) { out.push(sectionHead("Done / idle", doneP.length, "✓")); for (const p of doneP) out.push(renderProject(p)); }
  return out;
}

function renderMachineSwitcher(tree) {
  const nav = $("#machine-switcher");
  const machines = [...new Set((tree.projects || []).filter((p) => !p.hidden).map((p) => p.machine))];
  if (machines.length <= 1) { nav.replaceChildren(); nav.hidden = true; return; }
  nav.hidden = false;
  nav.replaceChildren();
  // "All" pill
  const totalLive = (tree.projects || []).reduce((n, p) => n + (p.hidden ? 0 : liveCount(p)), 0);
  nav.appendChild(machinePill("all", "🌐", "All machines", machines.length + " machines", totalLive, machineFilter === "all", null));
  // one pill per machine
  for (const m of machines) {
    const ps = (tree.projects || []).filter((p) => p.machine === m && !p.hidden);
    const live = ps.reduce((n, p) => n + liveCount(p), 0);
    nav.appendChild(machinePill(m, machineIcon(m), m, ps.length + " project" + (ps.length === 1 ? "" : "s"), live, machineFilter === m, machineHue(m, machines)));
  }
}

function machinePill(id, icon, label, sub, live, active, hue) {
  const b = el("button", "mpill" + (active ? " active" : ""));
  b.dataset.machine = id;
  if (hue) b.style.setProperty("--mhue", hue);
  const ic = el("span", "mpill-ic", icon);
  b.appendChild(ic);
  const txt = el("span", "mpill-txt");
  txt.appendChild(el("span", "mpill-name", label));
  txt.appendChild(el("span", "mpill-sub", sub));
  b.appendChild(txt);
  if (live > 0) { const d = el("span", "mpill-live"); d.title = live + " live"; b.appendChild(d); }
  b.addEventListener("click", () => {
    machineFilter = id;
    if (lastTree) render(lastTree);
  });
  return b;
}

function renderMachinePanel(mname, projects, machines) {
  const panel = el("div", "machine-panel");
  panel.style.setProperty("--mhue", machineHue(mname, machines));
  const live = projects.reduce((n, p) => n + liveCount(p), 0);
  if (live > 0) panel.classList.add("mp-live");

  const head = el("div", "machine-head");
  head.appendChild(el("span", "mp-ic", machineIcon(mname)));
  const nameWrap = el("div", "mp-namewrap");
  const nameRow = el("div", "mp-namerow");
  nameRow.appendChild(el("span", "mp-name", mname));
  if (live > 0) nameRow.appendChild(badge("live", "● " + live + " live"));
  nameWrap.appendChild(nameRow);
  const metaRow = el("div", "mp-meta");
  metaRow.appendChild(el("span", null, projects.length + " project" + (projects.length === 1 ? "" : "s")));
  const lastTs = projects.reduce((m, p) => (p.last_ts && p.last_ts > m ? p.last_ts : m), "");
  if (lastTs) { const s = el("span"); s.append("updated "); s.appendChild(timeEl("rel", lastTs)); metaRow.appendChild(s); }
  nameWrap.appendChild(metaRow);
  head.appendChild(nameWrap);
  // machine overall meter
  let done = 0, tot = 0;
  for (const p of projects) for (const s of p.stages || []) { done += s.num_done || 0; tot += s.num_todos || 0; }
  const mprog = tot ? (100 * done / tot) : null;
  const mm = el("div", "mp-meter-wrap");
  mm.appendChild(meter(mprog, "mini-meter"));
  mm.appendChild(el("span", "row-pct", pct(mprog)));
  head.appendChild(mm);
  panel.appendChild(head);

  const body = el("div", "machine-body");
  for (const node of activeDoneSections(projects)) body.appendChild(node);
  panel.appendChild(body);
  return panel;
}

function labelFor(f) { return { live: "Live", doing: "In progress", done: "Done", hidden: "Hidden" }[f] || f; }

function sectionHead(label, n, icon) {
  const h = el("div", "section-head");
  h.appendChild(el("span", "sh-icon", icon));
  h.appendChild(el("span", "sh-label", label));
  h.appendChild(el("span", "sh-count", String(n)));
  return h;
}

// EVERY running session gets its own card — you often have several going at once,
// so showing a single "foreground" one hid most of the truth.
function renderLiveNow(tree, visible) {
  const machines = [...new Set((tree.projects || []).map((p) => p.machine))];
  const live = [];
  for (const p of visible) {
    for (const s of p.stages || []) {
      if (s.running && !s.hidden) live.push({ s, p });
    }
  }
  // most-recently-active first
  live.sort((a, b) => (b.s.latest_ts || "").localeCompare(a.s.latest_ts || ""));

  $("#live-count").textContent = live.length;
  const grid = $("#live-grid");
  grid.replaceChildren();
  const section = $("#live-section");
  section.classList.toggle("idle", live.length === 0);

  if (live.length === 0) {
    const card = el("div", "live-card empty-card");
    card.appendChild(el("div", "lc-title", "Nothing running right now"));
    card.appendChild(el("div", "lc-sub", "start a Claude Code session on any machine and it appears here"));
    grid.appendChild(card);
    return;
  }

  for (const { s, p } of live) {
    const card = el("button", "live-card");
    card.style.setProperty("--mhue", machineHue(p.machine, machines));
    card.title = "Show this session";

    const top = el("div", "lc-top");
    const mchip = el("span", "lc-machine");
    mchip.append(machineIcon(p.machine) + " " + p.machine);
    top.appendChild(mchip);
    const el2 = el("span", "lc-elapsed");
    // measure the CURRENT process, not the whole session history — a resumed
    // session would otherwise read "running 21d".
    const runSince = s.run_started_ts || s.started_ts;
    if (runSince) { el2.append("running "); el2.appendChild(timeEl("elapsed", runSince)); }
    top.appendChild(el2);
    card.appendChild(top);

    card.appendChild(el("div", "lc-title", s.title));

    const sub = el("div", "lc-sub");
    sub.append(p.name + (s.subpath ? " / " + s.subpath : ""));
    if (s.latest_ts) { sub.append(" · active "); sub.appendChild(timeEl("rel", s.latest_ts)); }
    card.appendChild(sub);

    // current to-do, so you can see what it's actually on
    const cur = (s.subtasks || []).find((t) => t.status === "in_progress");
    if (cur) {
      const c = el("div", "lc-cur");
      c.appendChild(el("span", "lc-cur-ic", "◐"));
      c.appendChild(el("span", "lc-cur-txt", cur.text));
      card.appendChild(c);
    }

    const row = el("div", "lc-meter-row");
    row.appendChild(meter(s.progress));
    row.appendChild(el("span", "lc-num", s.num_todos ? (s.num_done + "/" + s.num_todos) : "—"));
    card.appendChild(row);

    // clicking a live card focuses that machine and opens the session
    card.addEventListener("click", () => {
      machineFilter = p.machine;
      filter = "all";
      // clear the search too — otherwise buildView() filters the very row we are
      // about to scroll to and the click silently does nothing.
      query = "";
      const sb = $("#search"); if (sb) sb.value = "";
      collapsedByUser.delete(p.key); collapsedByUser.delete(s.key);
      for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.filter === "all");
      expanded.add(p.key); expanded.add(s.key); saveExpanded();
      render(lastTree);
      const target = document.querySelector('[data-rowkey="' + cssEscape(s.key) + '"]');
      if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    grid.appendChild(card);
  }
}

function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

function meter(value, extraCls) {
  const track = el("div", "meter" + (extraCls ? " " + extraCls : ""));
  const fill = el("div", "meter-fill");
  if (value == null) { fill.classList.add("none"); fill.style.width = "0%"; }
  else { fill.style.width = Math.max(0, Math.min(100, value)) + "%"; if (value >= 100) fill.classList.add("done"); }
  track.appendChild(fill);
  return track;
}

function renderTabsCounts(tree) {
  let all = 0, live = 0, doing = 0, done = 0, hidden = 0;
  for (const p of tree.projects || []) {
    if (p.hidden) hidden++;
    for (const s of p.stages || []) {
      if (p.hidden || s.hidden) { if (s.hidden) hidden++; continue; }
      for (const t of s.subtasks || []) if (t.hidden) hidden++;
      all++;
      const st = stageState(s);
      if (st === "live") { live++; doing++; }
      else if (st === "doing") doing++;
      else if (st === "done") done++;
    }
  }
  $("#cnt-all").textContent = all;
  $("#cnt-live").textContent = live;
  $("#cnt-doing").textContent = doing;
  $("#cnt-done").textContent = done;
  $("#cnt-hidden").textContent = hidden;
}

function renderProject(p) {
  const box = el("div", "panel project");
  if (!p._hiddenSelf && liveCount(p) > 0 && filter !== "hidden") box.classList.add("live-glow");
  if (p._hiddenSelf) box.classList.add("dim");

  if (query) queryOpenKeys.add(p.key);
  const isOpen = isRowOpen(p.key);
  const head = el("div", "row-head");
  head.setAttribute("aria-expanded", String(isOpen));
  head.appendChild(el("span", "twist", "▶"));

  const main = el("div", "row-main");
  const title = el("div", "row-title");
  const name = el("span", "name", p.name);
  title.appendChild(name);
  // show the machine badge only when a single machine is selected (in the grouped
  // "All" view the panel header already names the machine)
  if (multiMachine && machineFilter !== "all" && p.machine) title.appendChild(badge("machine", machineIcon(p.machine) + " " + p.machine));
  const pLive = liveCount(p);
  if (pLive > 0) title.appendChild(badge("live", "● " + pLive + " live"));
  main.appendChild(title);
  // project time + counts line
  const sub = el("div", "row-time");
  sub.appendChild(el("span", "chiplet", (p.num_stages || 0) + " stage" + (p.num_stages === 1 ? "" : "s")));
  if (p.last_ts) { const s = el("span"); s.append("updated "); s.appendChild(timeEl("rel", p.last_ts)); sub.appendChild(s); }
  if (p.started_ts) { const s = el("span"); s.append("started "); s.appendChild(timeEl("rel", p.started_ts)); sub.appendChild(s); }
  main.appendChild(sub);
  head.appendChild(main);

  const meta = el("div", "row-meta");
  meta.appendChild(actions("project", p.key, p.name, name, p._hiddenSelf));
  meta.appendChild(meter(p.progress, "mini-meter"));
  meta.appendChild(el("span", "row-pct", pct(p.progress)));
  head.appendChild(meta);

  const body = el("div");
  body.hidden = !isOpen;
  wireRowToggle(head, body, p.key);
  box.appendChild(head);

  const list = el("div", "stage-list");
  if (p.stages.length === 0) list.appendChild(el("div", "no-tasks", "project itself is hidden — press show to bring it back"));
  for (const s of p.stages) list.appendChild(renderStage(p, s));
  body.appendChild(list);
  box.appendChild(body);
  return box;
}

function renderStage(p, s) {
  const box = el("div", "stage" + (s.running && filter !== "hidden" ? " foreground" : ""));
  box.dataset.rowkey = s.key;
  if (s.hidden) box.classList.add("dim");
  if (query && s._subMatch) queryOpenKeys.add(s.key);
  const isOpen = isRowOpen(s.key);
  const head = el("div", "row-head");
  head.setAttribute("aria-expanded", String(isOpen));
  head.appendChild(el("span", "twist", "▶"));

  const main = el("div", "row-main");
  const title = el("div", "row-title");
  title.appendChild(el("span", "name stage-title", s.title));
  if (s.running) title.appendChild(badge("live", "live"));
  if (s.subpath) title.appendChild(badge("subpath", "/" + s.subpath));
  if (s.git_branch && s.git_branch !== "HEAD") title.appendChild(badge("branch", s.git_branch));
  main.appendChild(title);
  // stage time line
  const tline = el("div", "row-time");
  if (s.running) {
    if (s.latest_ts) { const a = el("span"); a.append("active "); a.appendChild(timeEl("rel", s.latest_ts)); tline.appendChild(a); }
    const runSince = s.run_started_ts || s.started_ts;
    if (runSince) { const a = el("span"); a.append("running "); a.appendChild(timeEl("elapsed", runSince)); tline.appendChild(a); }
  } else {
    if (s.latest_ts) { const a = el("span"); a.append("last active "); a.appendChild(timeEl("rel", s.latest_ts)); tline.appendChild(a); }
    if (s.started_ts && s.latest_ts) { const a = el("span"); a.append("spanned "); a.appendChild(timeEl("dur", s.started_ts, s.latest_ts)); tline.appendChild(a); }
  }
  main.appendChild(tline);
  head.appendChild(main);

  const meta = el("div", "row-meta");
  meta.appendChild(actions("stage", s.key, s.title, main.querySelector(".name"), !!s.hidden));
  meta.appendChild(meter(s.progress, "mini-meter"));
  meta.appendChild(el("span", "row-pct", s.num_todos ? (s.num_done + "/" + s.num_todos) : "—"));
  head.appendChild(meta);

  const body = el("div");
  body.hidden = !isOpen;
  wireRowToggle(head, body, s.key);
  box.appendChild(head);

  const todos = (s.subtasks || []).filter((t) => filter === "hidden" ? true : !t.hidden);
  if (todos.length === 0) { const nt = el("div", "no-tasks", "no to-do list in this session"); nt.hidden = !isOpen; body.appendChild(nt); }
  else { const list = el("div", "subtasks"); for (const t of todos) list.appendChild(renderSubtask(t)); body.appendChild(list); }
  box.appendChild(body);
  return box;
}

function renderSubtask(t) {
  const row = el("div", "subtask " + (t.status || "pending"));
  if (t.hidden) row.classList.add("dim");
  const st = STATUS[t.status] || STATUS.pending;
  const chip = el("span", "chip " + (t.status || "pending"));
  chip.appendChild(el("span", "ic", st.ic));
  chip.appendChild(el("span", null, st.label));
  row.appendChild(chip);
  const txt = el("span", "text", t.text || "");
  row.appendChild(txt);
  row.appendChild(actions("subtask", t.key, t.text, txt, !!t.hidden));
  return row;
}

function badge(cls, txt) { return el("span", "badge " + cls, txt); }

// ---- expand row (mouse + keyboard) ------------------------------------------
function wireRowToggle(head, body, key) {
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  const doToggle = () => {
    // flip the EFFECTIVE state, so a row auto-opened by a search can be closed
    const open = !isRowOpen(key);
    setRowOpen(key, open);
    head.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  };
  head.addEventListener("click", (ev) => { if (ev.target.closest(".ghost-btn,.title-input")) return; doToggle(); });
  head.addEventListener("keydown", (ev) => {
    if (ev.target !== head) return;
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); doToggle(); }
  });
}

// ---- always-visible actions -------------------------------------------------
function actions(level, key, current, nameEl, hidden) {
  const wrap = el("span", "row-actions");
  const edit = el("button", "ghost-btn", "✎");
  edit.title = "Rename"; edit.setAttribute("aria-label", "Rename");
  edit.addEventListener("click", (e) => { e.stopPropagation(); if (nameEl) beginEdit(level, key, current, nameEl); });
  const hide = el("button", "ghost-btn", hidden ? "👁" : "⊘");
  hide.title = hidden ? "Show again" : "Hide"; hide.setAttribute("aria-label", hide.title);
  hide.addEventListener("click", (e) => { e.stopPropagation(); save(level, key, "hidden", !hidden); });
  wrap.append(edit, hide);
  return wrap;
}

function beginEdit(level, key, current, nameEl) {
  const input = el("input", "title-input");
  input.value = current;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (ok) => {
    if (done) return; done = true;
    const val = input.value.trim();
    const span = el("span", nameEl.className, ok && val ? val : current);
    input.replaceWith(span);
    if (ok && val && val !== current) save(level, key, "title", val);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(true); if (e.key === "Escape") commit(false); });
  input.addEventListener("blur", () => commit(true));
}

async function save(level, key, field, value) {
  try {
    const res = await fetch(SAVE_URL, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, key, field, value }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    toast(field === "hidden" ? (value ? "Hidden — find it under the Hidden tab" : "Shown again") : "Saved");
    await refresh();
  } catch (e) { toast("Couldn't save (" + e.message + ")", true); }
}

// ---- expand state -----------------------------------------------------------
function toggle(key) { setRowOpen(key, !isRowOpen(key)); }
function setAll(open) {
  if (!lastTree) return;
  for (const p of lastTree.projects || []) {
    if (open) expanded.add(p.key); else expanded.delete(p.key);
    for (const s of p.stages || []) { if (open) expanded.add(s.key); else expanded.delete(s.key); }
  }
  saveExpanded(); render(lastTree);
}
function resetFilters() {
  filter = "all"; query = ""; machineFilter = "all";
  $("#search").value = "";
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.filter === "all");
  if (lastTree) render(lastTree);
}

// ---- status ticker ----------------------------------------------------------
function tickStatus() {
  if (!lastTree) return;
  const sl = $("#status-line");
  const anyLive = (lastTree.projects || []).some((p) => !p.hidden && liveCount(p) > 0);
  sl.replaceChildren();
  sl.append("updated ");
  sl.appendChild(timeEl("rel", lastTree.generated_utc));
  sl.classList.toggle("live", anyLive);
}

// ---- toast / errors ---------------------------------------------------------
let toastTimer = null;
function toast(msg, isErr) {
  let t = $("#toast");
  if (!t) { t = el("div", "toast"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = "toast" + (isErr ? " err" : ""); }, 2400);
}
function showError(msg) { const e = $("#error"); e.textContent = msg; e.hidden = false; }
function clearError() { const e = $("#error"); e.hidden = true; e.textContent = ""; }

// ---- polling / lifecycle ----------------------------------------------------
async function refresh() { const tree = await fetchData(); if (tree) render(tree); return tree; }

// Manual refresh: always give visible feedback, and say whether anything changed.
// (Silence here is what made a WORKING button look broken.)
let refreshing = false;
async function manualRefresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = $("#refresh-btn");
  btn.classList.add("spinning");
  btn.disabled = true;
  const prevStamp = lastTree && lastTree.generated_utc;
  const started = Date.now();
  try {
    const tree = await refresh();
    if (tree) {
      const changed = tree.generated_utc !== prevStamp;
      toast(changed ? "Refreshed — new data just in" : ("Up to date — data collected " + (relTime(tree.generated_utc) || "recently")));
    }
  } finally {
    // keep the spin visible long enough to read as feedback on a fast response
    const wait = Math.max(0, 450 - (Date.now() - started));
    setTimeout(() => { btn.classList.remove("spinning"); btn.disabled = false; refreshing = false; }, wait);
  }
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  setInterval(() => { refreshTimes(); tickStatus(); }, 1000);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

function initTheme() {
  const saved = localStorage.getItem("cc_theme");
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  $("#theme-btn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : cur === "dark" ? null : "light";
    if (next) { document.documentElement.setAttribute("data-theme", next); localStorage.setItem("cc_theme", next); }
    else { document.documentElement.removeAttribute("data-theme"); localStorage.removeItem("cc_theme"); }
    repaintCharts();
  });
  const os = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (os && os.addEventListener) os.addEventListener("change", () => repaintCharts());
}

function initControls() {
  $("#refresh-btn").addEventListener("click", manualRefresh);
  $("#expand-all").addEventListener("click", () => setAll(true));
  $("#collapse-all").addEventListener("click", () => setAll(false));
  $("#search").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    queryOpenKeys.clear(); collapsedByUser.clear();
    if (lastTree) render(lastTree);
  });
  // keyboard: "/" focuses search, Escape clears it, "r" refreshes
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || "");
    if (e.key === "/" && !typing) { e.preventDefault(); $("#search").focus(); $("#search").select(); }
    else if (e.key === "Escape" && typing && e.target.id === "search") { e.target.value = ""; query = ""; e.target.blur(); if (lastTree) render(lastTree); }
    else if ((e.key === "r" || e.key === "R") && !typing && !e.metaKey && !e.ctrlKey) { manualRefresh(); }
  });
  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab"); if (!btn) return;
    filter = btn.dataset.filter;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === btn);
    if (lastTree) render(lastTree);
  });
}

function currentView() {
  return new URLSearchParams(location.search).get("view") === "prompting" ? "prompting" : "progress";
}

function showView(name, push) {
  const nav = $("#view-switch");
  for (const b of nav.querySelectorAll(".seg-btn")) {
    b.setAttribute("aria-selected", String(b.dataset.view === name));
  }
  moveThumb(nav);
  $("#view-progress").hidden = name !== "progress";
  $("#view-prompting").hidden = name !== "prompting";
  if (name === "prompting") { openPrompting(); } else { closePrompting(); }
  if (push) {
    const url = new URL(location.href);
    if (name === "progress") url.searchParams.delete("view");
    else url.searchParams.set("view", name);
    history.replaceState(null, "", url);
  }
  revealOnScroll();
}

function initViews() {
  const nav = $("#view-switch");
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (btn) showView(btn.dataset.view, true);
  });
  addEventListener("resize", () => moveThumb(nav));
  navShadow($("#topbar"));
}

async function init() {
  initTheme(); initControls(); initViews();
  const params = new URLSearchParams(location.search);
  const th = params.get("theme");
  if (th === "dark" || th === "light") document.documentElement.setAttribute("data-theme", th);
  await refresh();
  if (params.get("open") === "all" && lastTree) setAll(true);
  const f = params.get("filter");
  if (f && ["all", "live", "doing", "done", "hidden"].includes(f)) {
    filter = f;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.filter === f);
    if (lastTree) render(lastTree);
  }
  const q = params.get("q");
  if (q) { $("#search").value = q; query = q.toLowerCase(); }
  const mc = params.get("machine");
  if (mc) machineFilter = mc;
  if ((q || mc) && lastTree) render(lastTree);
  showView(currentView(), false);
  requestAnimationFrame(() => moveThumb($("#view-switch")));
  startPolling();
}
document.addEventListener("DOMContentLoaded", init);
