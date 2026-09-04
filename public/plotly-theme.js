// plotly-theme.js — one look for every chart, taken from the page's own tokens.
//
// Plotly cannot read a CSS custom property, so the values are resolved at draw
// time and passed in. That is also why a theme switch rebuilds the whole figure
// rather than relayouting a template: trace colours, error bars, reference
// lines and annotations all carry colour, and a template does not reach them.

"use strict";

import { reduced } from "./motion.js";

export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fallback) => (cs.getPropertyValue(n) || "").trim() || fallback;
  return {
    text: v("--text", "#1d1d1f"),
    text2: v("--text-2", "#6e6e73"),
    text3: v("--text-3", "#86868b"),
    rule: v("--rule-soft", "#e8e8ed"),
    surface: v("--surface", "#fff"),
    surface2: v("--surface-2", "#fafafc"),
    accent: v("--accent", "#0066cc"),
    green: v("--green", "#1d9a3e"),
    amber: v("--amber", "#b25000"),
    red: v("--red", "#c41e1e"),
    font: v("--sans", "-apple-system, sans-serif"),
  };
}

export function baseLayout(t, over = {}) {
  return Object.assign({
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: t.font, size: 13, color: t.text2 },
    margin: { l: 150, r: 24, t: 8, b: 44 },
    showlegend: false,
    hovermode: "closest",
    hoverlabel: { bgcolor: t.surface, bordercolor: t.rule,
                  font: { family: t.font, size: 13, color: t.text } },
    xaxis: { gridcolor: t.rule, zeroline: false, linecolor: t.rule,
             tickcolor: t.rule, automargin: true,
             title: { font: { size: 12, color: t.text3 } } },
    yaxis: { gridcolor: "rgba(0,0,0,0)", zeroline: false, linecolor: "rgba(0,0,0,0)",
             tickcolor: "rgba(0,0,0,0)", automargin: true },
    // Constant so a refresh keeps the reader's zoom and legend choices.
    uirevision: "keep",
  }, over);
}

export const CONFIG = {
  displaylogo: false,
  responsive: true,
  displayModeBar: false,
  scrollZoom: false,
};

/** Motion is only ever applied to a deliberate change, never to a refresh. */
export function transition() {
  return reduced() ? { duration: 0 } : { duration: 250, easing: "cubic-in-out" };
}

const band = (b) => ({
  type: "data", symmetric: false,
  array: [Math.max(0, (b.bandHi ?? b.rate) - b.rate)],
  arrayminus: [Math.max(0, b.rate - (b.bandLo ?? b.rate))],
  thickness: 1, width: 0, color: "rgba(128,128,128,0.5)",
});

/**
 * Turn a finding's chart description into traces and a layout.
 * Groups too small to read are drawn grey and said so on hover, never hatched.
 */
export function figureFor(chart, t) {
  const MIN_N = 5;
  if (chart.kind === "bars") {
    const b = chart.buckets;
    const colors = b.map((x, i) =>
      x.n < MIN_N ? t.rule : (i === chart.highlight ? t.accent : t.text3));
    const trace = {
      type: "bar", orientation: "h",
      x: b.map((x) => x.rate), y: b.map((x) => x.label),
      marker: { color: colors, cornerradius: 4 },
      error_x: { type: "data", symmetric: false,
                 array: b.map((x) => Math.max(0, (x.bandHi ?? x.rate) - x.rate)),
                 arrayminus: b.map((x) => Math.max(0, x.rate - (x.bandLo ?? x.rate))),
                 thickness: 1, width: 0, color: t.text3 },
      customdata: b.map((x) => [x.n, x.calls ?? null]),
      hovertemplate: b.map((x) => x.n < MIN_N
        ? "%{y}<br>not enough sessions yet (n=%{customdata[0]})<extra></extra>"
        : "%{y}<br>%{x:.2f} " + (chart.xTitle || "") + "<br>%{customdata[0]} sessions<extra></extra>"),
    };
    const layout = baseLayout(t, {
      xaxis: Object.assign(baseLayout(t).xaxis, { title: { text: chart.xTitle, font: { size: 12, color: t.text3 } } }),
      height: Math.max(140, b.length * 46 + 60),
    });
    if (chart.reference != null) {
      layout.shapes = [{ type: "line", x0: chart.reference, x1: chart.reference,
                         yref: "paper", y0: 0, y1: 1,
                         line: { color: t.text3, width: 1, dash: "dot" } }];
      layout.annotations = [{ x: chart.reference, yref: "paper", y: 1.04,
                              text: chart.referenceLabel || "", showarrow: false,
                              font: { size: 11, color: t.text3 }, xanchor: "left" }];
    }
    return { data: [trace], layout };
  }

  if (chart.kind === "dots") {
    const rows = chart.rows;
    const trace = {
      type: "scatter", mode: "markers", orientation: "h",
      x: rows.map((r) => r.rate), y: rows.map((r) => r.label),
      marker: { size: 11, color: rows.map((r) => (r.accent ? t.accent : t.text3)) },
      error_x: { type: "data", symmetric: false,
                 array: rows.map((r) => Math.max(0, (r.bandHi ?? r.rate) - r.rate)),
                 arrayminus: rows.map((r) => Math.max(0, r.rate - (r.bandLo ?? r.rate))),
                 thickness: 1, width: 0, color: t.text3 },
      customdata: rows.map((r) => [r.n]),
      hovertemplate: "%{y}<br>%{x:.2f} " + (chart.xTitle || "") +
                     "<br>%{customdata[0]} sessions<extra></extra>",
    };
    return { data: [trace], layout: baseLayout(t, {
      xaxis: Object.assign(baseLayout(t).xaxis, { title: { text: chart.xTitle, font: { size: 12, color: t.text3 } } }),
      height: rows.length * 56 + 70,
    }) };
  }

  if (chart.kind === "dumbbell") {
    const rows = chart.rows;
    const lines = rows.map((r, i) => ({
      type: "scatter", mode: "lines", x: [r.a, r.b], y: [r.label, r.label],
      line: { color: t.rule, width: 2 }, hoverinfo: "skip", showlegend: false,
    }));
    const present = {
      type: "scatter", mode: "markers", name: "included",
      x: rows.map((r) => r.a), y: rows.map((r) => r.label),
      marker: { size: 10, color: t.text3 },
      hovertemplate: "%{y}<br>included: %{x:.2f}<extra></extra>",
    };
    const missing = {
      type: "scatter", mode: "markers", name: "left out",
      x: rows.map((r) => r.b), y: rows.map((r) => r.label),
      marker: { size: 10, color: t.accent },
      hovertemplate: "%{y}<br>left out: %{x:.2f}<extra></extra>",
    };
    return { data: [...lines, present, missing], layout: baseLayout(t, {
      showlegend: true,
      legend: { orientation: "h", y: -0.25, font: { size: 12, color: t.text2 } },
      xaxis: Object.assign(baseLayout(t).xaxis, { title: { text: chart.xTitle, font: { size: 12, color: t.text3 } } }),
      height: rows.length * 42 + 110,
    }) };
  }

  if (chart.kind === "compaction") {
    const pts = chart.points;
    const pct = (p) => (p.pre && chart.window ? (p.pre / chart.window) * 100 : 0);
    const drops = pts.map((p) => ({
      type: "scatter", mode: "lines", hoverinfo: "skip", showlegend: false,
      x: [p.at_min, p.at_min],
      y: [pct(p), p.post && chart.window ? (p.post / chart.window) * 100 : 0],
      line: { color: t.rule, width: 1 },
    }));
    const dots = {
      type: "scatter", mode: "markers",
      x: pts.map((p) => p.at_min), y: pts.map(pct),
      marker: { size: 11, color: pts.map((p) => (p.trigger === "manual" ? t.accent : t.text3)) },
      customdata: pts.map((p) => [p.trigger, Math.round((p.post || 0) / 1000)]),
      hovertemplate: "%{customdata[0]} compaction at minute %{x:.0f}<br>" +
                     "context was %{y:.0f}% full, kept %{customdata[1]}K tokens<extra></extra>",
    };
    const layout = baseLayout(t, {
      margin: { l: 56, r: 24, t: 8, b: 44 },
      height: 260,
      xaxis: Object.assign(baseLayout(t).xaxis, { title: { text: "minutes into the session", font: { size: 12, color: t.text3 } } }),
      yaxis: Object.assign(baseLayout(t).yaxis, {
        title: { text: "context used, %", font: { size: 12, color: t.text3 } },
        gridcolor: t.rule, range: [0, 105] }),
      shapes: [{ type: "rect", xref: "paper", x0: 0, x1: 1, y0: 60, y1: 75,
                 fillcolor: t.accent, opacity: 0.07, line: { width: 0 } }],
      annotations: [{ xref: "paper", x: 0.01, y: 67, text: "compact by choice",
                      showarrow: false, font: { size: 11, color: t.text3 }, xanchor: "left" }],
    });
    return { data: [...drops, dots], layout };
  }

  return null;
}

/** The table twin every chart needs: the same numbers, reachable without a mouse. */
export function tableFor(chart, caption) {
  const tbl = document.createElement("table");
  tbl.className = "chart-table";
  const cap = document.createElement("caption");
  cap.textContent = caption;
  tbl.appendChild(cap);
  const head = document.createElement("tr");
  const rows = chart.kind === "bars" ? chart.buckets : chart.rows;
  const cols = chart.kind === "dumbbell"
    ? ["group", "included", "left out"]
    : ["group", chart.xTitle || "value", "sessions"];
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  tbl.appendChild(head);
  for (const r of rows || []) {
    const tr = document.createElement("tr");
    const cells = chart.kind === "dumbbell"
      ? [r.label, fmt(r.a), fmt(r.b)]
      : [r.label, fmt(r.rate), r.n != null ? String(r.n) : ""];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;                 // textContent, never innerHTML
      tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }
  return tbl;
}

function fmt(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2);
}
