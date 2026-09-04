// plotly-loader.js — fetch the charting library once, only when it is needed.
//
// The Progress view never loads it. The Prompting view asks for it the first
// time it opens, and every chart on the page shares that one promise.
//
// Pinned with an integrity hash: the CDN is outside this site's trust boundary,
// and a password gate in front of a page does not protect a script behind it.

"use strict";

const VERSION = "4.0.0";
const FILE = "plotly-cartesian.min.js";
// sha512 of the 4.0.0 cartesian bundle, taken from the cdnjs API and confirmed
// by recomputing it from the downloaded file. jsdelivr serves the same bytes.
const SRI = "sha512-ifogayzlQmfFFuURcn71EEKG6El0zIoeRkrOPDud5wnON3VbeoOOHgefaguvS04LdnWnLKOjtrKZNEmE9aPx0g==";
const SOURCES = [
  `https://cdnjs.cloudflare.com/ajax/libs/plotly.js/${VERSION}/${FILE}`,
  `https://cdn.jsdelivr.net/npm/plotly.js-cartesian-dist-min@${VERSION}/${FILE}`,
];

let pending = null;

export function loadPlotly(timeoutMs = 20000) {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (pending) return pending;
  pending = attempt(0, timeoutMs).catch((err) => { pending = null; throw err; });
  return pending;
}

function attempt(i, timeoutMs) {
  if (i >= SOURCES.length) {
    return Promise.reject(new Error(
      "could not be loaded from either CDN (network, an extension, or a content policy)"));
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SOURCES[i];
    s.integrity = SRI;          // also fires onerror if the bytes do not match
    s.crossOrigin = "anonymous";
    s.async = true;
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.remove();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("timed out"), timeoutMs);
    s.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (window.Plotly) {
        window.Plotly.setPlotConfig({ displaylogo: false, responsive: true });
        resolve(window.Plotly);
      } else {
        fail("loaded but did not define Plotly");
      }
    };
    s.onerror = () => fail("request failed");
    document.head.appendChild(s);
  }).catch(() => attempt(i + 1, timeoutMs));
}

/** Charts must not be drawn into a box with no size, or they measure to zero. */
export function watchResize(el, Plotly) {
  if (!window.ResizeObserver) return;
  const ro = new ResizeObserver(() => {
    if (el.offsetParent !== null && el.clientWidth > 0) Plotly.Plots.resize(el);
  });
  ro.observe(el);
  return ro;
}
