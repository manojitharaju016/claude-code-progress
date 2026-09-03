#!/usr/bin/env python3
"""
cc-progress local server (no account, no GitHub, no Cloudflare).

Runs on your machine. Serves the dashboard, reads your Claude Code logs LIVE via
reader.py on each request, merges your local edits (overlay.json), and saves
edits back locally. Gated by a shared password (HTTP Basic Auth).

Open it:
  * locally:        http://127.0.0.1:8787/
  * from elsewhere:  ssh -L 8787:localhost:8787 <you>@<host>   then http://localhost:8787/
  * on the LAN:     start with --host 0.0.0.0 and open http://<host-ip>:8787/

Password: read from env CC_PROGRESS_PASSWORD, else from
~/.claude/cc-progress/.site_password (created with a random one if missing).

Usage:
  python3 server.py                 # 127.0.0.1:8787 (use an SSH tunnel to reach it)
  python3 server.py --host 0.0.0.0 --port 8787
"""

import argparse
import base64
import hmac
import json
import os
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import reader  # noqa: E402  (reused: build tree, scrub, fingerprint)

PUBLIC_DIR = os.path.join(ROOT, "repo", "public")
OVERLAY_FILE = os.path.join(ROOT, "overlay.json")
PASSWORD_FILE = os.path.join(ROOT, ".site_password")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

# module-level cache shared across requests (reader skips unchanged logs)
_READER_CACHE = reader.load_cache()


def get_password():
    env = os.environ.get("CC_PROGRESS_PASSWORD")
    if env:
        return env
    try:
        with open(PASSWORD_FILE) as fh:
            p = fh.read().strip()
            if p:
                return p
    except OSError:
        pass
    # generate one, store 600, and announce it
    p = secrets.token_urlsafe(12)
    fd = os.open(PASSWORD_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(p + "\n")
    sys.stderr.write("\n*** cc-progress: generated a site password ***\n"
                     "    password: %s\n"
                     "    (stored in %s — change it there anytime)\n\n" % (p, PASSWORD_FILE))
    return p


def load_overlay():
    try:
        with open(OVERLAY_FILE) as fh:
            o = json.load(fh)
        if isinstance(o, dict):
            return o
    except (OSError, ValueError):
        pass
    return {"schema_version": 1, "projects": {}, "stages": {}, "subtasks": {}}


def save_overlay(o):
    tmp = OVERLAY_FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(o, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, OVERLAY_FILE)


def apply_overlay(tree, overlay):
    P = overlay.get("projects", {}); S = overlay.get("stages", {}); T = overlay.get("subtasks", {})
    for proj in tree.get("projects", []):
        po = P.get(proj["key"])
        if po:
            if po.get("title"):
                proj["name"] = po["title"]
            if "hidden" in po:
                proj["hidden"] = bool(po["hidden"])
        for st in proj.get("stages", []):
            so = S.get(st["key"])
            if so:
                if so.get("title"):
                    st["title"] = so["title"]
                if "hidden" in so:
                    st["hidden"] = bool(so["hidden"])
            for sub in st.get("subtasks", []):
                to = T.get(sub["key"])
                if to and to.get("title"):
                    sub["text"] = to["title"]


def build_merged():
    denyset = None  # reader scrubs at build time already
    tree = reader.build(_READER_CACHE)
    reader.save_cache(_READER_CACHE)
    apply_overlay(tree, load_overlay())
    # defense in depth: scrub any overlay-provided titles too
    for p in tree.get("projects", []):
        p["name"] = reader.scrub(p.get("name", ""), set())
        for st in p.get("stages", []):
            st["title"] = reader.scrub(st.get("title", ""), set())
            for sub in st.get("subtasks", []):
                sub["text"] = reader.scrub(sub.get("text", ""), set())
    return tree


class Handler(BaseHTTPRequestHandler):
    server_version = "cc-progress/1.0"
    password = None  # set in main()

    def log_message(self, *a):  # quiet
        pass

    # --- auth ---
    def _authed(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(h[6:]).decode("utf-8", "replace")
        except Exception:
            return False
        pw = decoded.split(":", 1)[1] if ":" in decoded else ""
        return hmac.compare_digest(pw, self.password)

    def _require_auth(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Work Progress", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Authentication required.")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authed():
            return self._require_auth()
        path = self.path.split("?", 1)[0]
        if path == "/api/data":
            try:
                return self._json(build_merged())
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        return self._serve_static(path)

    def do_POST(self):
        if not self._authed():
            return self._require_auth()
        path = self.path.split("?", 1)[0]
        if path != "/api/save":
            return self._json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, TypeError):
            return self._json({"error": "bad json"}, 400)
        level, key, field = body.get("level"), body.get("key"), body.get("field")
        value = body.get("value")
        if level not in ("project", "stage", "subtask"):
            return self._json({"error": "bad level"}, 400)
        if field not in ("title", "hidden"):
            return self._json({"error": "bad field"}, 400)
        if not isinstance(key, str) or not key:
            return self._json({"error": "bad key"}, 400)
        if field == "title":
            value = str(value or "").strip()[:300]
            if not value:
                return self._json({"error": "empty title"}, 400)
        else:
            value = bool(value)
        overlay = load_overlay()
        group = level + "s"
        overlay.setdefault(group, {})
        overlay[group].setdefault(key, {})
        overlay[group][key][field] = value
        save_overlay(overlay)
        return self._json({"ok": True})

    def _serve_static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        # prevent path traversal
        rel = os.path.normpath(path).lstrip("/")
        full = os.path.join(PUBLIC_DIR, rel)
        if not os.path.abspath(full).startswith(os.path.abspath(PUBLIC_DIR)) or not os.path.isfile(full):
            self.send_response(404); self.end_headers(); self.wfile.write(b"not found"); return
        ext = os.path.splitext(full)[1]
        ctype = MIME.get(ext, "application/octet-stream")
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_response(500); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args(argv)

    Handler.password = get_password()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write("cc-progress serving on http://%s:%d/  (Ctrl-C to stop)\n" % (args.host, args.port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
