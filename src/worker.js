/*
 * Claude Code — Work Progress: Cloudflare Worker.
 *
 * One entry point for the whole site. It:
 *   1. gates EVERY request behind a shared password (HTTP Basic Auth), so the
 *      static page and the API are both protected (needs run_worker_first=true);
 *   2. GET /api/data  — reads data/progress.json + data/overlay.json from the
 *      private repo's `data` branch via the GitHub API, merges them (your overlay
 *      wins), re-scrubs secrets, returns JSON to the browser;
 *   3. POST /api/save — writes ONLY data/overlay.json back to the repo, using the
 *      current blob SHA for a safe concurrent update (one retry on conflict).
 *
 * Secrets (set in the Cloudflare dashboard, never in the repo, never sent to the
 * browser):  GH_TOKEN (fine-grained, single repo, Contents read+write),
 *            SITE_PASSWORD (the shared password).
 * Vars (wrangler.toml): GH_OWNER, GH_REPO, DATA_BRANCH.
 */

const GH_API = "https://api.github.com";
const PROGRESS_PATH = "data/progress.json";
const OVERLAY_PATH = "data/overlay.json";

export default {
  async fetch(request, env) {
    // --- 1. password gate (covers everything) ---
    if (!authorized(request, env)) {
      return new Response("Authentication required.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Work Progress", charset="UTF-8"' },
      });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/data") return await handleData(request, env);
      if (url.pathname === "/api/save") return await handleSave(request, env);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }

    // --- static assets (index.html, styles.css, app.js) ---
    return env.ASSETS.fetch(request);
  },
};

// --- auth -------------------------------------------------------------------

function authorized(request, env) {
  const want = env.SITE_PASSWORD;
  if (!want) return false; // fail closed if not configured
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  // decode as UTF-8 (browsers send Basic credentials as UTF-8 bytes; raw atob
  // would garble any non-ASCII password character and lock the user out)
  try { decoded = b64ToUtf8(header.slice(6)); } catch (_) { return false; }
  const pass = decoded.slice(decoded.indexOf(":") + 1); // username ignored
  return timingSafeEqual(pass, want);
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// --- GET /api/data ----------------------------------------------------------

async function handleData(request, env) {
  // Every machine pushes its own progress.json to its own branch (data-<machine>).
  // Discover them all, fetch each, and merge into one view.
  let branches, overlay;
  try {
    [branches, overlay] = await Promise.all([
      listMachineBranches(env),
      ghGetJson(env, OVERLAY_PATH, env.OVERLAY_BRANCH).catch(() => null),
    ]);
  } catch (err) {
    // GitHub unreachable / rate-limited / token expired -> error (not empty tree)
    // so the browser keeps the last good view + shows a banner.
    return json({ error: "github-unavailable", detail: String((err && err.message) || err) }, 503);
  }

  let tree;
  if (!branches.length) {
    tree = emptyTree();
  } else {
    const feeds = await Promise.all(branches.map((b) =>
      ghGetJson(env, PROGRESS_PATH, b).then((j) => j).catch(() => null)
    ));
    const ok = feeds.filter(Boolean);
    if (ok.length === 0) return json({ error: "github-unavailable", detail: "all machine feeds failed" }, 503);
    tree = mergeFeeds(ok);
  }
  applyOverlay(tree, overlay || {});
  scrubTree(tree);
  return json(tree, 200, { "Cache-Control": "no-store" });
}

// Never let Cloudflare's edge (or GitHub's CDN) hand us a cached copy: unique
// query param + cacheTtl 0. Without this a refresh can return stale progress.
function noCache(url) {
  return url + (url.includes("?") ? "&" : "?") + "_cb=" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}
const NO_CACHE_INIT = { cf: { cacheTtl: 0, cacheEverything: false } };

async function listMachineBranches(env) {
  const prefix = env.DATA_PREFIX || "data-";
  const res = await fetch(
    noCache(`${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/branches?per_page=100`),
    { headers: ghHeaders(env), ...NO_CACHE_INIT }
  );
  if (!res.ok) throw new Error("branches " + res.status);
  const arr = await res.json();
  return (arr || []).map((b) => b.name).filter((n) => n === "data" || n.startsWith(prefix));
}

function mergeFeeds(trees) {
  const projects = [];
  let genMax = "";
  for (const t of trees) {
    for (const p of t.projects || []) projects.push(p);
    if (t.generated_utc && t.generated_utc > genMax) genMax = t.generated_utc;
  }
  // one global "working now": the running stage with the newest activity across ALL machines
  let fgP = null, fgS = null, fgTs = "";
  for (const p of projects) for (const s of p.stages || []) {
    if (s.running && (s.latest_ts || "") > fgTs) { fgTs = s.latest_ts || ""; fgP = p.key; fgS = s.key; }
  }
  for (const p of projects) for (const s of p.stages || []) s.foreground = (s.key === fgS);
  const active = projects.filter((p) => (p.num_active || 0) > 0).length;
  const stages = projects.reduce((n, p) => n + (p.num_stages || 0), 0);
  return {
    schema_version: 1,
    machine: trees.length === 1 ? (trees[0].machine || "?") : "all",
    generated_utc: genMax || null,
    counts: { projects: projects.length, active_projects: active, stages },
    foreground: { project_key: fgP, stage_key: fgS },
    projects,
  };
}

function emptyTree() {
  return {
    schema_version: 1, machine: "?", generated_utc: null,
    counts: { projects: 0, active_projects: 0, stages: 0 },
    foreground: { project_key: null, stage_key: null }, projects: [],
  };
}

function applyOverlay(tree, overlay) {
  const P = overlay.projects || {}, S = overlay.stages || {}, T = overlay.subtasks || {};
  for (const proj of tree.projects || []) {
    const po = P[proj.key];
    if (po) {
      if (po.title) proj.name = po.title;
      if (po.hidden != null) proj.hidden = !!po.hidden;
    }
    for (const st of proj.stages || []) {
      const so = S[st.key];
      if (so) {
        if (so.title) st.title = so.title;
        if (so.hidden != null) st.hidden = !!so.hidden;
      }
      for (const sub of st.subtasks || []) {
        const to = T[sub.key];
        if (to) {
          if (to.title) sub.text = to.title;
          if (to.hidden != null) sub.hidden = !!to.hidden;
        }
      }
    }
  }
}

// --- POST /api/save ---------------------------------------------------------

async function handleSave(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "bad json" }, 400); }

  const level = body.level, key = body.key, field = body.field;
  let value = body.value;
  if (!["project", "stage", "subtask"].includes(level)) return json({ error: "bad level" }, 400);
  if (!["title", "hidden"].includes(field)) return json({ error: "bad field" }, 400);
  if (typeof key !== "string" || !key) return json({ error: "bad key" }, 400);
  if (field === "title") { value = String(value || "").slice(0, 300); if (!value) return json({ error: "empty title" }, 400); }
  if (field === "hidden") value = !!value;

  const group = level + "s"; // projects / stages / subtasks
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await ghGetContent(env, OVERLAY_PATH, env.OVERLAY_BRANCH); // {json, sha} or null
    const overlay = (cur && cur.json) || { schema_version: 1, projects: {}, stages: {}, subtasks: {} };
    overlay[group] = overlay[group] || {};
    overlay[group][key] = Object.assign({}, overlay[group][key], { [field]: value });
    const res = await ghPutContent(
      env, OVERLAY_PATH, overlay, cur && cur.sha,
      `overlay: ${level} ${field} update`, env.OVERLAY_BRANCH
    );
    if (res.ok) return json({ ok: true });
    if (res.status === 409 || res.status === 422) continue; // stale sha -> retry once
    return json({ error: "github " + res.status, detail: await safeText(res) }, 502);
  }
  return json({ error: "conflict, try again" }, 409);
}

// --- GitHub helpers ---------------------------------------------------------

function ghHeaders(env, accept) {
  return {
    "Authorization": "Bearer " + env.GH_TOKEN,
    "Accept": accept || "application/vnd.github+json",
    "User-Agent": "cc-progress-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function contentsUrl(env, path) {
  return `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
}

async function ghGetJson(env, path, branch) {
  // Resolve the branch tip commit first and fetch content AT that commit —
  // fetching by branch NAME can serve GitHub's cached copy for up to ~a minute,
  // which made the dashboard lag behind fresh pushes. Falls back to the branch
  // name if the tip lookup fails.
  let ref = branch;
  try {
    // the tip lookup must ALSO be uncacheable — a cached tip resolves a stale SHA
    // and then faithfully serves stale content.
    const tip = await fetch(noCache(`${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/branches/${encodeURIComponent(branch)}`),
      { headers: ghHeaders(env), ...NO_CACHE_INIT });
    if (tip.ok) {
      const meta = await tip.json();
      if (meta && meta.commit && meta.commit.sha) ref = meta.commit.sha;
    }
  } catch (_) { /* fall back to branch name */ }
  const url = noCache(contentsUrl(env, path) + "?ref=" + encodeURIComponent(ref));
  const res = await fetch(url, { headers: ghHeaders(env, "application/vnd.github.raw+json"), ...NO_CACHE_INIT });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("github get " + res.status);
  return await res.json();
}

async function ghGetContent(env, path, branch) {
  // JSON blob metadata (content + sha) for read-modify-write
  const url = noCache(contentsUrl(env, path) + "?ref=" + encodeURIComponent(branch));
  const res = await fetch(url, { headers: ghHeaders(env), ...NO_CACHE_INIT });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("github getcontent " + res.status);
  const meta = await res.json();
  let parsed = null;
  try { parsed = JSON.parse(b64ToUtf8(meta.content.replace(/\n/g, ""))); } catch (_) {}
  return { json: parsed, sha: meta.sha };
}

async function ghPutContent(env, path, obj, sha, message, branch) {
  const payload = {
    message,
    content: utf8ToB64(JSON.stringify(obj, null, 2)),
    branch: branch,
  };
  if (sha) payload.sha = sha;
  return fetch(contentsUrl(env, path), {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(payload),
  });
}

// --- secret scrubbing (defense in depth) ------------------------------------

const SECRET_RES = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_\-]{20,}/g,
];
function scrub(s) {
  if (typeof s !== "string") return s;
  for (const re of SECRET_RES) s = s.replace(re, "«redacted»");
  return s;
}
function scrubTree(tree) {
  for (const p of tree.projects || []) {
    p.name = scrub(p.name);
    for (const st of p.stages || []) {
      st.title = scrub(st.title);
      for (const sub of st.subtasks || []) sub.text = scrub(sub.text);
    }
  }
}

// --- utils ------------------------------------------------------------------

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, extra || {}),
  });
}
async function safeText(res) { try { return (await res.text()).slice(0, 200); } catch (_) { return ""; } }

// Named exports for unit testing (Cloudflare uses the default export above).
export { applyOverlay, scrub, scrubTree, utf8ToB64, b64ToUtf8, timingSafeEqual, emptyTree, mergeFeeds };
