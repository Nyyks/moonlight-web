"""The P4 flows of the laboratory driver (plan upscaler-mwsr.md §3.6, §8.1):
the conformity of the twins (C11).

The product's two renderers, driven by the chain cells on the same pictures
as the kernel cells, are held to the kernel in two ways:

- **pixels** — on the golden cases: the WebGPU chain must give the kernel
  cell's picture exactly (the same text, the same views); the WebGL2 chain
  the same picture to 2/255 per channel wherever no screen derivative is
  involved (the reduction), and on the kernel the pixel statistics are
  reported: the vote and the edge frame come from the GPU's screen
  derivatives, whose quad (coarse) reference row is the implementation's
  choice and differs between the two APIs' window spaces (the first
  conformity run, 21/10/2026), so the twins cannot be identical on an edge;
- **quality** — on the ground-truth pictures of the quality flow at ×2 (text,
  game, code): PSNR, SSIM, overshoot and FLIP of each twin against the ground
  truth must be the same to the noise (FLIP 0.002, PSNR 0.1 dB, overshoot
  0.1 %). That is the criterion the kernel is held to.

On the software adapters the two sides cannot share a Chrome (ANGLE forced on
SwiftShader switches WebGPU off), so the flow is run once per side: first
`--swiftshader --conformity` (the WebGPU cells, the ground truths and the
reduced inputs), then `--webgl-swiftshader --conformity` (the WebGL2 chain on
those inputs), each run dumping its cells under the same names and comparing
every pair whose two dumps are on disk. On a GPU (one Chrome for both) a single
run does it all. Called from scaler_lab.py with its `run_page`.
"""
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import metrics  # noqa: E402
import p3_flows  # noqa: E402

# The channel difference a port may show where no derivative is involved
# (plan §3.6: beyond it, a bug, not a tolerance) — on all but a thousandth of
# the pixels, and never more than CONFORMITY_MAX: the two APIs' samplers do not
# weigh a bilinear tap to the same subtexel precision, which the zone plate
# turns into 3/255 on a hundred pixels (21/10/2026).
CONFORMITY_TOL = 2
CONFORMITY_SHARE = 0.001
CONFORMITY_MAX = 4
# The quality the two twins must share, against the ground truth.
QUALITY_TOL = {"flip": 0.002, "psnr": 0.1, "overshoot": 0.001}

# (what is compared, the cell it must match at scale, the cell it must match below 1:1)
PAIRS = [
    ("chain-mwsr", "mwsr", "mwsr:srgb=1"),
    ("chain-gl-mwsr", "mwsr", "mwsr"),
]
GL_CELLS = ["chain-gl-mwsr"]
# The quality leg: the ground truth at this size, reduced to the input (×2).
QUALITY_IN, QUALITY_OUT = "1280x720", "2560x1440"
QUALITY_CONTENT = ["text", "game", "code"]
QUALITY_CELLS = ["tex-s1", "mwsr", "chain-mwsr"]


def cases():
    return sorted({(c, i, o) for c, i, o, _ in p3_flows.GOLDEN_CASES})


def dump_path(a, base, cell):
    return os.path.join(a.dir, base + "-" + re.sub(r"[^\w.+-]", "_", cell) + ".png")


def conformity(a, run_page):
    """Each golden case rendered by this Chrome's cells, the quality pictures
    too, then every pair whose two dumps exist. Exit 1 when a pair is out of
    tolerance or a run failed; a pair whose other side has not run yet is only
    pending."""
    from scaler_lab import make_input  # the driver's own, lazily (it imports this module)

    gl_side = getattr(a, "webgl_swiftshader", False)
    bad = 0
    adapter = None

    def page(query, key):
        nonlocal bad, adapter
        res = run_page(query)
        if "error" in res:
            print(key, "ERROR", res["error"][:600])
            bad += 1
            return None
        adapter = (res.get("adapter") or {}).get("name", adapter)  # a gt=1 page names none
        if res.get("errors"):
            print(key, "errors:", res["errors"][:5])
            bad += 1
        return res

    # ── pixels: the golden cases ──
    for content, size_in, size_out in cases():
        down = int(size_out.split("x")[0]) < int(size_in.split("x")[0])
        if gl_side:
            cells = list(GL_CELLS)
        else:
            cells = sorted({c for p in PAIRS for c in (p[0], p[2] if down else p[1])})
            if a.swiftshader:
                cells = [c for c in cells if c not in GL_CELLS]
        base = "conf-%s-%s-%s" % (content, size_in, size_out)
        key = "%s %s->%s" % (content, size_in, size_out)
        res = page("in=%s&out=%s&content=%s&codec=none&cells=%s&dump=all%s&tag=%s" % (
            size_in, size_out, content, ",".join(cells), p3_flows.QUICK, base), key)
        if res is None:
            continue
        missing = [c for c in cells if not os.path.exists(dump_path(a, base, c))]
        if missing:
            print(key, "not dumped:", missing)
            bad += 1
        sys.stdout.flush()

    # ── quality: the ground-truth pictures at ×2 ──
    iw, ih = (int(x) for x in QUALITY_IN.split("x"))
    for content in QUALITY_CONTENT:
        base = "conf-q-%s" % content
        gt_path = os.path.join(a.dir, base + "-gt.png")
        in_path = os.path.join(a.dir, base + "-in.png")
        if gl_side:
            if not os.path.exists(in_path):
                print(base, "pending: the WebGPU side makes the ground truth and the input (--swiftshader --conformity first)")
                continue
            cells = list(GL_CELLS)
        else:
            res = page("gt=1&content=%s&out=%s&tag=%s" % (content, QUALITY_OUT, base), base + " ground truth")
            if res is None:
                continue
            make_input(gt_path, in_path, (iw, ih))
            cells = list(QUALITY_CELLS) + ([] if a.swiftshader else GL_CELLS)
        res = page("in=%s&out=%s&content=img:/__dir/%s-in.png&codec=none&cells=%s&dump=all%s&tag=%s" % (
            QUALITY_IN, QUALITY_OUT, base, ",".join(cells), p3_flows.QUICK, base), base)
        if res is None:
            continue
        missing = [c for c in cells if not os.path.exists(dump_path(a, base, c))]
        if missing:
            print(base, "not dumped:", missing)
            bad += 1
        sys.stdout.flush()
    print("side %s (%s) rendered; comparing the dumps on disk" % ("WebGL2" if gl_side else "WebGPU", adapter))

    # ── the pixel table ──
    rows = []
    pending = 0
    for content, size_in, size_out in cases():
        down = int(size_out.split("x")[0]) < int(size_in.split("x")[0])
        key = "%s %s->%s" % (content, size_in, size_out)
        base = "conf-%s-%s-%s" % (content, size_in, size_out)
        for what, up_ref, down_ref in PAIRS:
            ref = down_ref if down else up_ref
            px, py = dump_path(a, base, what), dump_path(a, base, ref)
            if not (os.path.exists(px) and os.path.exists(py)):
                pending += 1
                continue
            x, y = metrics.load(px), metrics.load(py)
            if x.shape != y.shape:
                print("  %-28s %-14s vs %-12s shapes differ %s %s" % (key, what, ref, x.shape, y.shape))
                bad += 1
                continue
            d = np.abs(np.rint(x * 255.0) - np.rint(y * 255.0))
            worst = int(d.max())
            differ = float((d > 0).any(axis=-1).mean())
            over = float((d > CONFORMITY_TOL).any(axis=-1).mean())
            psnr = metrics.psnr(y, x) if worst else float("inf")
            # the WebGL2 kernel is held by its quality (below), not by its pixels
            held = not (what == "chain-gl-mwsr" and not down)
            ok = (over <= CONFORMITY_SHARE and worst <= CONFORMITY_MAX) if held else True
            if not ok:
                bad += 1
            rows.append((key, what, ref, worst, differ, over, psnr, ok, held))
            print("  %-28s %-14s vs %-12s max %3d/255  differ %6.2f %%  over %6.3f %%  psnr %s  %s" % (
                key, what, ref, worst, 100 * differ, 100 * over,
                "exact" if worst == 0 else metrics.fmt(psnr, 1),
                ("OK" if ok else "OUT OF TOLERANCE") if held else "reported (derivatives)"))
    if pending:
        print("  %d pixel pair(s) pending: the other side has not run yet" % pending)

    # ── the quality table ──
    qrows = []
    qpending = 0
    for content in QUALITY_CONTENT:
        base = "conf-q-%s" % content
        gt_path = os.path.join(a.dir, base + "-gt.png")
        in_path = os.path.join(a.dir, base + "-in.png")
        if not (os.path.exists(gt_path) and os.path.exists(in_path)):
            qpending += 1
            continue
        gt, inp = metrics.load(gt_path), metrics.load(in_path)
        got = {}
        for cell in QUALITY_CELLS + GL_CELLS:
            p = dump_path(a, base, cell)
            if os.path.exists(p):
                got[cell] = metrics.measure(gt, inp, metrics.load(p))
        for cell, m in got.items():
            print("  %-6s %-14s psnr %6.2f  ssim %.4f  overshoot %5.2f %%  flip %s" % (
                content, cell, m["psnr"], m["ssim"], 100 * m["overshoot"], metrics.fmt(m["flip"])))
        ref, gl = got.get("mwsr"), got.get("chain-gl-mwsr")
        if ref is None or gl is None:
            qpending += 1
            continue
        d_flip = None if ref["flip"] is None or gl["flip"] is None else abs(gl["flip"] - ref["flip"])
        d_psnr = abs(gl["psnr"] - ref["psnr"])
        d_over = abs(gl["overshoot"] - ref["overshoot"])
        ok = (d_flip is None or d_flip <= QUALITY_TOL["flip"]) and d_psnr <= QUALITY_TOL["psnr"] \
            and d_over <= QUALITY_TOL["overshoot"]
        if not ok:
            bad += 1
        qrows.append((content, ref, gl, d_flip, d_psnr, d_over, ok))
        print("  %-6s WebGL2 twin vs kernel: flip %s  psnr %.3f dB  overshoot %.3f %%  %s" % (
            content, metrics.fmt(d_flip) if d_flip is not None else "-", d_psnr, 100 * d_over,
            "OK" if ok else "NOT THE SAME QUALITY"))
    if qpending:
        print("  %d quality case(s) pending: the other side has not run yet" % qpending)
    print("conformity: %s" % ("OK" if not bad else "%d problem(s)" % bad))

    if a.md and (rows or qrows):
        path = os.path.join(a.dir, a.tag + "-conformity.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("# Conformity of the twins\n\n")
            if rows:
                f.write("## Pixels (golden cases)\n\n")
                f.write("| case | chain | reference | max /255 | pixels differing | pixels over %d/255 | PSNR dB | |\n"
                        % CONFORMITY_TOL)
                f.write("|---|---|---|---|---|---|---|---|\n")
                for key, what, ref, worst, differ, over, psnr, ok, held in rows:
                    f.write("| %s | `%s` | `%s` | %d | %.2f %% | %.3f %% | %s | %s |\n" % (
                        key, what, ref, worst, 100 * differ, 100 * over,
                        "exact" if worst == 0 else metrics.fmt(psnr, 1),
                        ("OK" if ok else "**out**") if held else "reported"))
            if qrows:
                f.write("\n## Quality against the ground truth (×2)\n\n")
                f.write("| content | twin | PSNR dB | SSIM | overshoot % | FLIP | ΔFLIP | ΔPSNR | |\n")
                f.write("|---|---|---|---|---|---|---|---|---|\n")
                for content, ref, gl, d_flip, d_psnr, d_over, ok in qrows:
                    for name, m in (("WGSL `mwsr`", ref), ("GLSL `gl-mwsr`", gl)):
                        f.write("| %s | %s | %.2f | %.4f | %.2f | %s | | | |\n" % (
                            content, name, m["psnr"], m["ssim"], 100 * m["overshoot"], metrics.fmt(m["flip"])))
                    f.write("| %s | difference | | | | | %s | %.3f | %s |\n" % (
                        content, metrics.fmt(d_flip) if d_flip is not None else "-", d_psnr,
                        "OK" if ok else "**not the same**"))
        print("wrote", path)
    return 1 if bad else 0
