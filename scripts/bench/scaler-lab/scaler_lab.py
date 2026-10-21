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
import shutil
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
    ("x075-text", "in=2560x1440&out=1920x1080&content=text&set=feed,base"),
    ("x2-ui", "in=1280x720&out=2560x1440&content=ui&set=feed,base"),
    ("x2-text-tick", "in=1280x720&out=2560x1440&content=text&set=feed,base&pace=tick&batches=6"),
]

# The P1 set (--p1; upscaler-mwsr.md §5, gate C7): the product's chain at 1:1,
# where every pass must now cost what 'off' costs, next to what the same passes
# cost at scale 1 before (pass 0 + kernel on the same frame); the same chain
# paced like the product; then the passage 1:1 <-> x2 on every other draw.
P1_CASES = [
    ("x1-chain", "in=2560x1440&out=2560x1440&content=text"
                 "&cells=blit,tex-s1,blit%2Bsgsr-repo,blit%2Bnis,blit%2Bfsr1,chain-off,chain-sgsr,chain-nis,chain-fsr1&rounds=2"),
    ("x1-chain-tick", "in=2560x1440&out=2560x1440&content=text"
                      "&cells=chain-off,chain-sgsr,chain-nis,chain-fsr1&pace=tick&rounds=2"),
    ("x2-flip", "in=1280x720&out=2560x1440&content=text"
                "&cells=chain-off,chain-sgsr,chain-nis,chain-fsr1&flip=1&rounds=2"),
]


# The P2 set (--p2; upscaler-mwsr.md §3, §6, criteria C1-C2): the mwsr kernel
# next to the floor (one and five bilinear taps), its two orientations, with
# and without the branch, on the external texture, and the shipped kernels;
# three pictures at ×2, text at ×1.33.
P2_CELLS = ("tex-s1,tex-s5,tex-s9,mwsr,mwsr:dering=0,mwsr:early=0,mwsr:orient=0,"
            "ext-s1,ext-s5,ext-mwsr,ext-mwsr:dering=0,sgsr-repo,fsr1,nis")
P2_CASES = [
    ("x2-text", "in=1280x720&out=2560x1440&content=text&cells=%s&rounds=3" % P2_CELLS),
    ("x2-ui", "in=1280x720&out=2560x1440&content=ui&cells=%s&rounds=3" % P2_CELLS),
    ("x2-game", "in=1280x720&out=2560x1440&content=game&cells=%s&rounds=3" % P2_CELLS),
    ("x133-text", "in=1920x1080&out=2560x1440&content=text&cells=%s&rounds=3" % P2_CELLS),
    ("x133-game", "in=1920x1080&out=2560x1440&content=game&cells=%s&rounds=3" % P2_CELLS),
]


class LabHandler(Handler):
    """The repository, C:\\Test under /test/, the output directory under /__dir/,
    results posted under /__result, pictures (PNG) under /__png."""

    def translate_path(self, path):
        clean = path.split("?", 1)[0]
        if clean.startswith("/test/"):
            return os.path.join(TEST_IMAGES, os.path.basename(clean))
        if clean.startswith("/__dir/"):
            return os.path.join(self.server.lab_dir, os.path.basename(clean))
        return super().translate_path(path)

    def do_GET(self):
        # Short links for a phone: /1, /2, /3 redirect to the long case URLs.
        target = getattr(self.server, "short", {}).get(self.path)
        if target:
            self.send_response(302)
            self.send_header("Location", target)
            self.end_headers()
            return
        return super().do_GET()

    def _name(self):
        name = "lab"
        if "name=" in self.path:
            name = self.path.split("name=", 1)[1].split("&", 1)[0]
        return "".join(c for c in urllib.request.unquote(name) if c.isalnum() or c in "-_.")

    def _save_png(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        out = os.path.join(self.server.lab_dir, self._name() + ".png")
        with open(out, "wb") as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_POST(self):
        if self.path.startswith("/__png"):
            return self._save_png()
        if not self.path.startswith("/__result"):
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        name = self._name()
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


def chain_note(c):
    """A chain cell's extras: the draws that were the renderer's 1:1 copy, the
    pass count of each draw, and the GPU total by pass count (flip=1)."""
    seq = c.get("passSeq") or {}
    parts = ["1:1 copies %s/%s" % (c.get("copies"), sum(seq.values())),
             "passes %s" % json.dumps(seq, sort_keys=True)]
    for k, g in sorted((c.get("byPasses") or {}).items()):
        parts.append("%s-pass p50 %s" % (k, fmt((g or {}).get("p50"), 1)))
    return " / ".join(parts)


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
        if c.get("feed") == "chain":
            print("  %-18s %s" % ("", chain_note(c)))
    if res.get("errors"):
        for e in res["errors"][:12]:
            print("  error:", e[:300])


def make_input(gt_path, in_path, size):
    """The ground truth reduced to the input size: Lanczos-3, in linear light
    (§7.1 rule 2), once, so that every cell reads the same picture."""
    import numpy as np
    from PIL import Image
    img = np.asarray(Image.open(gt_path).convert("RGB"), dtype=np.float32) / 255.0
    lin = np.where(img <= 0.04045, img / 12.92, ((img + 0.055) / 1.055) ** 2.4)
    chans = [Image.fromarray(np.ascontiguousarray(lin[..., c]), mode="F").resize(size, Image.LANCZOS)
             for c in range(3)]
    lin2 = np.clip(np.stack([np.asarray(c, dtype=np.float32) for c in chans], axis=2), 0.0, 1.0)
    srgb = np.where(lin2 <= 0.0031308, lin2 * 12.92, 1.055 * np.power(lin2, 1 / 2.4) - 0.055)
    Image.fromarray((srgb * 255.0 + 0.5).astype(np.uint8), mode="RGB").save(in_path)


QUALITY_CELLS = "tex-s1,sgsr-repo,sgsr-src,nis,easu,fsr1,mwsr"

# The phone set: the ×2 case with the product's chain, the reduction a phone
# does most (§1.6), and a game picture; 2 rounds so that a slot holds 10 min.
PHONE_CASES = [
    ("x2-text", "in=1280x720&out=2560x1440&content=text&set=feed,base,chain&rounds=2&batches=6"),
    ("x075-text", "in=2560x1440&out=1920x1080&content=text&set=feed,base&rounds=2&batches=6"),
    ("x2-game", "in=1280x720&out=2560x1440&content=game&set=feed,base&rounds=2&batches=6"),
    # The same three, one submission per iteration (pace=tick, no period): on a
    # tile-based GPU (iPhone 13 Pro, 20/10) the per-pass timestamps of a long
    # command buffer are not additive, a pass's begin is taken while the
    # previous passes still run; one pass per command buffer reads right.
    ("x2-text-single", "in=1280x720&out=2560x1440&content=text&set=feed,base&rounds=2&batches=6&pace=tick&period=0.01"),
    ("x075-text-single", "in=2560x1440&out=1920x1080&content=text&set=feed,base&rounds=2&batches=6&pace=tick&period=0.01"),
    ("x2-game-single", "in=1280x720&out=2560x1440&content=game&set=feed,base&rounds=2&batches=6&pace=tick&period=0.01"),
]


def local_ips():
    import socket
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:  # noqa: BLE001
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def ensure_cert(directory, ips):
    """A self-signed certificate for the LAN addresses (WebGPU needs a secure
    context; a phone's Safari accepts it after its warning). Made by openssl."""
    cert = os.path.join(directory, "lab-cert.pem")
    key = os.path.join(directory, "lab-key.pem")
    if os.path.exists(cert) and os.path.exists(key) and time.time() - os.path.getmtime(cert) < 6 * 3600:
        return cert, key
    san = ",".join("IP:" + ip for ip in ips) + ",DNS:localhost,IP:127.0.0.1"
    for exe in ("openssl", r"C:\Program Files\Git\mingw64\bin\openssl.exe", r"C:\Program Files\Git\usr\bin\openssl.exe"):
        try:
            subprocess.run([exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
                            "-days", "2", "-subj", "/CN=mw-scaler-lab", "-addext", "subjectAltName=" + san],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return cert, key
        except (OSError, subprocess.CalledProcessError):
            continue
    raise SystemExit("openssl not found: cannot make the lab's certificate")


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
            if c.get("feed") == "chain":
                lines.append("| | | | | | | | %s |" % chain_note(c))
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
    ap.add_argument("--p1", action="store_true", help="the P1 set (the chain at 1:1, the passage 1:1 <-> x2) instead of P0's")
    ap.add_argument("--p2", action="store_true", help="the P2 set (the mwsr kernel against the floor and the shipped kernels)")
    ap.add_argument("--quality-cells", default="", help="the cells of --quality instead of %s (mwsr variants…)" % QUALITY_CELLS)
    ap.add_argument("--dir", default=os.path.join(REPO, "bench-out", "scaler-lab"))
    ap.add_argument("--chrome-arg", action="append", default=[])
    ap.add_argument("--headed", default="", help="X,Y,W,H: a shown window there instead of headless")
    ap.add_argument("--remote-cdp", type=int, default=0, help="DevTools port of an already running Chrome")
    ap.add_argument("--http-port", type=int, default=0, help="fixed port for the server (remote runs)")
    ap.add_argument("--serve", default="", help="host:port — serve for a phone (HTTPS, self-signed) and wait for posted results")
    ap.add_argument("--no-tls", action="store_true", help="--serve in plain HTTP (no WebGPU on a phone then)")
    ap.add_argument("--md", action="store_true", help="write <dir>/<tag>.md, a table of the run")
    ap.add_argument("--quality", action="append", default=[],
                    help="a content (text, ui, game, code, zone, img:<url>): its ground truth at --out, the "
                         "Lanczos-3 input at --in, the kernels on it (%s), their outputs through metrics.py"
                         % QUALITY_CELLS)
    ap.add_argument("--in", dest="size_in", default="1280x720")
    ap.add_argument("--out", dest="size_out", default="2560x1440")
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
        ips = local_ips()
        scheme = "http"
        if not a.no_tls:
            import ssl
            cert, key = ensure_cert(a.dir, ips)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            server.socket = ctx.wrap_socket(server.socket, server_side=True)
            scheme = "https"
        cases = case_list(a.case or PHONE_CASES)
        server.short = {}
        sys.stdout.reconfigure(line_buffering=True)  # the log shows each 'posted' at once
        print("open on the phone, one after the other (each ends with 'posted' here):")
        for k, (name, query) in enumerate(cases, 1):
            path = "/scripts/bench/scaler-lab/scaler-lab.html?%s%s&post=1&tag=%s-%s" % (query, extra, a.tag, name)
            server.short["/%d" % k] = path
            for ip in ips or ["<this machine>"]:
                print("  %s://%s:%s/%d  ->  %s" % (scheme, ip, port, k, path))
        sys.stdout.flush()
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

        def run_page(query):
            url = "http://127.0.0.1:%d/scripts/bench/scaler-lab/scaler-lab.html?%s%s" % (http_port, query, extra)
            call("Page.navigate", url=url)
            for _ in range(1200):
                time.sleep(0.5)
                ready = call("Runtime.evaluate", returnByValue=True,
                             expression="location.href === %s && window.__labResult !== undefined" % json.dumps(url))
                if ready.get("result", {}).get("value"):
                    break
            r = call("Runtime.evaluate", expression="window.__labResult", awaitPromise=True, returnByValue=True)
            res = r.get("result", {}).get("value") or {"error": json.dumps(r)[:2000]}
            res["url"] = url
            return res

        if a.quality:
            sys.path.insert(0, HERE)
            import metrics
            inw, inh = (int(x) for x in a.size_in.split("x"))
            for content in a.quality:
                base = "%s-%s" % (a.tag, content.replace(":", "_").replace("/", "_"))
                res = run_page("gt=1&content=%s&out=%s&tag=%s" % (content, a.size_out, base))
                if "error" in res:
                    print(base, "ground truth ERROR", res["error"][:600])
                    continue
                gt_path = os.path.join(a.dir, base + "-gt.png")
                in_path = os.path.join(a.dir, base + "-in.png")
                make_input(gt_path, in_path, (inw, inh))
                res = run_page("in=%s&out=%s&content=img:/__dir/%s-in.png&codec=none&cells=%s&dump=%s"
                               "&rounds=1&batches=1&batch=4&warm=1&tag=%s" % (
                                   a.size_in, a.size_out, base, a.quality_cells or QUALITY_CELLS,
                                   "all" if a.quality_cells else "base", base))
                if "error" in res:
                    print(base, "cells ERROR", res["error"][:600])
                    continue
                print("== quality %s (%s -> %s), adapter %s" % (base, a.size_in, a.size_out, res["adapter"]["name"]))
                gt = metrics.load(gt_path)
                inp = metrics.load(in_path)
                rows = []
                for name in res.get("dumped", []):
                    cell = name[len(base) + 1:]
                    if "show" in cell:
                        # The vote painted (SHOW 1): the share of output pixels on the edge path.
                        share = float(metrics.load(os.path.join(a.dir, name + ".png"))[..., 1].mean())
                        print("  %-12s edge path %5.1f%% of the pixels" % (cell, 100 * share))
                        continue
                    r = metrics.measure(gt, inp, metrics.load(os.path.join(a.dir, name + ".png")))
                    r["cell"] = cell
                    rows.append(r)
                    print("  %-12s PSNR %6.2f  SSIM %.4f  SSIM Y %.4f  overshoot %5.2f%%  centre PSNR %6.2f SSIM %.4f  FLIP %s" % (
                        r["cell"], r["psnr"], r["ssim"], r["ssimY"], 100 * r["overshoot"],
                        r["centre"]["psnr"], r["centre"]["ssim"], metrics.fmt(r["flip"])))
                if res.get("errors"):
                    print("  errors:", res["errors"][:5])
                with open(os.path.join(a.dir, base + "-quality.json"), "w") as f:
                    json.dump({"adapter": res["adapter"], "gt": gt_path, "input": in_path, "rows": rows}, f, indent=1)
                sys.stdout.flush()
            return

        cases = case_list(a.case or (P1_CASES if a.p1 else P2_CASES if a.p2 else None))
        for name, query in cases:
            t0 = time.time()
            res = run_page(query)
            res["case"] = name
            res["tag"] = a.tag
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
            try:
                chrome.wait(timeout=10)
            except Exception:  # noqa: BLE001
                pass
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)  # the throw-away Chrome profile
    if a.md:
        path = os.path.join(a.dir, a.tag + ".md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(md_table(a.tag, runs))
        print("wrote", path)


if __name__ == "__main__":
    main()
