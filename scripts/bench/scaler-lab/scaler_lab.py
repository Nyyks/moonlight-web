"""The upscaler laboratory (docs/design/upscaler-mwsr.md, §6) in a Chrome of
its own: scaler-lab.html, case after case, each case a query of scaler-lab.js.

    python scaler_lab.py --tag rtx [--case NAME:QUERY ...] [--power low-power]
                         [--chrome-arg=--use-adapter-luid=0,<low>] [--headed X,Y,W,H]
                         [--swiftshader] [--serve 0.0.0.0:8766]

Without --case, the P0 set below: the feed experiment (§6.4: N bilinear taps
on the external texture against pass 0 + N on RGBA) and the baselines of the
shipped kernels, at ×2 and ×1.33 to 1440p, on text and on a game-like picture,
back to back and at 60 Hz. Each case writes <dir>/<tag>-<case>.json and a line
per cell here; --md writes a Markdown table of the whole run.

The page is served from the repository root (its modules import the product's
renderer), cross-origin isolated. --swiftshader runs the software adapter
(the "WARP first" rule of a new shader: nothing on a real GPU before the
shaders compile and draw there). --serve keeps the server up on an address a
phone can reach, and prints the URL to open there: the page then posts its
result back (post=1), to <dir>/phone-<name>.json.

Needs `pip install websocket-client`.
"""
import argparse
import functools
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import websocket

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ultra"))
from decoder_lab import CHROME, REPO, Handler, free_port  # noqa: E402

TEST_IMAGES = r"C:\Test"

# The P0 set: (name, query). `set=feed,base` by default; chain cells drive the
# product's renderer and are heavier, so they run on the two main cases only.
DEFAULT_CASES = [
    ("x2-text", "in=1280x720&out=2560x1440&content=text&set=feed,base,chain"),
    ("x2-game", "in=1280x720&out=2560x1440&content=game&set=feed,base,chain"),
    ("x133-text", "in=1920x1080&out=2560x1440&content=text&set=feed,base"),
    ("x133-game", "in=1920x1080&out=2560x1440&content=game&set=feed,base"),
    ("x1-text", "in=1920x1080&out=1920x1080&content=text&set=feed,base"),
    ("x2-text-tick", "in=1280x720&out=2560x1440&content=text&set=feed,base&pace=tick&batches=6"),
]


class LabHandler(Handler):
    """The repository, C:\\Test under /test/, results posted under /__result."""

    def translate_path(self, path):
        clean = path.split("?", 1)[0]
        if clean.startswith("/test/"):
            return os.path.join(TEST_IMAGES, os.path.basename(clean))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_POST(self):
        if not self.path.startswith("/__result"):
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        name = "phone"
        if "name=" in self.path:
            name = self.path.split("name=", 1)[1].split("&", 1)[0]
        name = "".join(c for c in urllib.request.unquote(name) if c.isalnum() or c in "-_.")
        out = os.path.join(self.server.lab_dir, "phone-%s-%d.json" % (name, int(time.time())))
        with open(out, "wb") as f:
            f.write(body)
        print("posted:", out)
        try:
            res = json.loads(body)
            print_result(name, res)
        except Exception as e:  # noqa: BLE001
            print("  (unreadable: %s)" % e)
        self.send_response(204)
        self.end_headers()


def case_list(given):
    """(name, query) pairs: the --case strings, or the default tuples."""
    return [tuple(c.split(":", 1)) if isinstance(c, str) else c for c in (given or DEFAULT_CASES)]


def fmt(x, w=7, d=3):
    return ("%*.*f" % (w, d, x)) if isinstance(x, (int, float)) else " " * (w - 1) + "-"


def print_result(name, res):
    if "error" in res:
        print("%-16s ERROR %s" % (name, res["error"][:800]))
        return
    a = res["adapter"]
    print("%-16s %s | ts=%s f16=%s | %s | %s" % (
        name, a.get("name"), res.get("timestamps"), "shader-f16" in res.get("features", []),
        res["params"]["in"] + "->" + res["params"]["out"] + " " + res["params"]["content"] + " " + res["params"]["pace"],
        json.dumps(res.get("frames")) if res.get("frames") else "no frames"))
    print("  %-18s %5s %8s %8s %8s %7s %9s  %s" % ("cell", "pass", "gpu p50", "p90", "p99", "disp%", "wall/iter", "per pass p50"))
    for c in res["cells"]:
        g = c.get("gpu") or {}
        print("  %-18s %5d %s %s %s %s %s  %s" % (
            c["name"], c.get("passes") or 0, fmt(g.get("p50"), 8), fmt(g.get("p90"), 8), fmt(g.get("p99"), 8),
            fmt(c.get("disp"), 7, 1), fmt(c.get("wallPerIter"), 9),
            " ".join(fmt(x, 6) for x in (c.get("perPass") or []))))
    if res.get("errors"):
        for e in res["errors"][:12]:
            print("  error:", e[:300])


def md_table(tag, runs):
    lines = ["# scaler-lab — %s" % tag, ""]
    for name, res in runs:
        if "error" in res:
            lines += ["## %s" % name, "", "ERROR " + res["error"][:500], ""]
            continue
        a = res["adapter"]
        p = res["params"]
        lines += ["## %s — %s → %s, %s, %s" % (name, p["in"], p["out"], p["content"], p["pace"]), "",
                  "Adapter: %s · timestamps: %s · features: %s" % (a.get("name"), res.get("timestamps"), " ".join(res.get("features", []))),
                  "", "Frames: `%s`" % json.dumps(res.get("frames")), "",
                  "| cell | passes | GPU p50 ms | p90 | p99 | dispersion % | wall/iter ms | per pass p50 |",
                  "|---|---|---|---|---|---|---|---|"]
        for c in res["cells"]:
            g = c.get("gpu") or {}
            lines.append("| %s | %d | %s | %s | %s | %s | %s | %s |" % (
                c["name"], c.get("passes") or 0, fmt(g.get("p50"), 1), fmt(g.get("p90"), 1), fmt(g.get("p99"), 1),
                fmt(c.get("disp"), 1, 1), fmt(c.get("wallPerIter"), 1), " / ".join(fmt(x, 1) for x in (c.get("perPass") or []))))
        if res.get("errors"):
            lines += ["", "Errors:", ""] + ["- `%s`" % e[:300] for e in res["errors"][:20]]
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--case", action="append", default=[], help="NAME:QUERY (scaler-lab.js parameters)")
    ap.add_argument("--extra", default="", help="query appended to every case (rounds=1, shot=1, codec=none...)")
    ap.add_argument("--power", default="", help="high-performance or low-power (the adapter asked for)")
    ap.add_argument("--swiftshader", action="store_true", help="the software adapter (fallback), for a first run")
    ap.add_argument("--dir", default=os.path.join(REPO, "bench-out", "scaler-lab"))
    ap.add_argument("--chrome-arg", action="append", default=[])
    ap.add_argument("--headed", default="", help="X,Y,W,H: a shown window there instead of headless")
    ap.add_argument("--remote-cdp", type=int, default=0, help="DevTools port of an already running Chrome")
    ap.add_argument("--http-port", type=int, default=0, help="fixed port for the server (remote runs)")
    ap.add_argument("--serve", default="", help="host:port — serve for a phone and wait for posted results")
    ap.add_argument("--md", action="store_true", help="write <dir>/<tag>.md, a table of the run")
    a = ap.parse_args()
    os.makedirs(a.dir, exist_ok=True)

    extra = ""
    if a.power:
        extra += "&power=" + a.power
    if a.swiftshader:
        extra += "&fallback=1"
    if a.extra:
        extra += "&" + a.extra.lstrip("&")

    if a.serve:
        host, port = a.serve.split(":")
        server = http.server.ThreadingHTTPServer((host, int(port)), functools.partial(LabHandler, directory=REPO))
        server.lab_dir = a.dir
        cases = case_list(a.case or DEFAULT_CASES[:1])
        print("open on the phone (then wait for 'posted'):")
        for name, query in cases:
            print("  http://<this machine>:%s/scripts/bench/scaler-lab/scaler-lab.html?%s%s&post=1&tag=%s-%s" % (
                port, query, extra, a.tag, name))
        server.serve_forever()
        return

    http_port = a.http_port or free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", http_port), functools.partial(LabHandler, directory=REPO))
    server.lab_dir = a.dir
    threading.Thread(target=server.serve_forever, daemon=True).start()

    cdp_port = a.remote_cdp or free_port()
    profile = tempfile.mkdtemp(prefix="mw-scaler-lab-")
    window = []
    if a.headed:
        x, y, w, h = a.headed.split(",")
        window = ["--window-position=%s,%s" % (x, y), "--window-size=%s,%s" % (w, h)]
    flags = ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--mute-audio",
             "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling",
             "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
    if a.swiftshader:
        flags += ["--enable-unsafe-swiftshader"]
    chrome = None if a.remote_cdp else subprocess.Popen([
        CHROME, *([] if a.headed else ["--headless=new"]), "--remote-debugging-port=%d" % cdp_port,
        "--user-data-dir=" + profile, *flags, *window, "about:blank",
    ] + a.chrome_arg, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    runs = []
    try:
        page = None
        for _ in range(50):
            try:
                targets = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % cdp_port))
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        if not page:
            raise SystemExit("no page on the DevTools port %d" % cdp_port)
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=1800, suppress_origin=True)
        ids = iter(range(1, 1 << 30))

        def call(method, **params):
            mid = next(ids)
            ws.send(json.dumps({"id": mid, "method": method, "params": params}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid:
                    return msg.get("result", msg)

        cases = case_list(a.case)
        for name, query in cases:
            url = "http://127.0.0.1:%d/scripts/bench/scaler-lab/scaler-lab.html?%s%s" % (http_port, query, extra)
            call("Page.navigate", url=url)
            t0 = time.time()
            for _ in range(1200):
                time.sleep(0.5)
                ready = call("Runtime.evaluate", returnByValue=True,
                             expression="location.href === %s && window.__labResult !== undefined" % json.dumps(url))
                if ready.get("result", {}).get("value"):
                    break
            r = call("Runtime.evaluate", expression="window.__labResult", awaitPromise=True, returnByValue=True)
            res = r.get("result", {}).get("value") or {"error": json.dumps(r)[:2000]}
            res["case"] = name
            res["tag"] = a.tag
            res["url"] = url
            res["wallSeconds"] = time.time() - t0
            shots = res.pop("shots", None)
            with open(os.path.join(a.dir, "%s-%s.json" % (a.tag, name)), "w") as f:
                json.dump(res, f, indent=1)
            if shots:
                import base64
                for cell, data in shots.items():
                    with open(os.path.join(a.dir, "%s-%s-%s.png" % (a.tag, name, cell)), "wb") as f:
                        f.write(base64.b64decode(data.split(",", 1)[1]))
            print_result(name, res)
            sys.stdout.flush()
            runs.append((name, res))
    finally:
        if chrome:
            chrome.kill()
        server.shutdown()
    if a.md:
        path = os.path.join(a.dir, a.tag + ".md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(md_table(a.tag, runs))
        print("wrote", path)


if __name__ == "__main__":
    main()
