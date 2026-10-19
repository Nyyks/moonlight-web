"""Quality of an upscaler's output against the ground truth (plan upscaler-mwsr
§7.2, criteria C3, C4, C10).

    python metrics.py --gt <gt.png> --input <in.png> <cell.png> ... [--json out.json] [--md out.md]

For each output: PSNR and SSIM (scikit-image; SSIM with the Gaussian window of
Wang et al.) against the ground truth; the mean FLIP error when the
flip-evaluator package is importable (it has no wheel for Python 3.14 yet:
then the column stays empty, and the verdicts of C3 wait for it); and the
overshoot rate, a no-reference measure of ringing: the share of output pixels
that leave the min/max of the four input texels around them (the bilinear
footprint) by more than 2/255 on any channel. A sharpener always overshoots a
little; a kernel that rings on text overshoots a lot.

Also: the same figures on the central third of the picture (where the bench
pictures put their text), and the SSIM of the luma alone.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image
from skimage.metrics import peak_signal_noise_ratio, structural_similarity

try:
    import flip_evaluator as flip  # noqa: F401
except Exception:  # noqa: BLE001
    flip = None


def load(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def overshoot(out, inp, tol=2.0 / 255.0):
    """Share of output pixels beyond the local 2×2 min/max of the input."""
    oh, ow = out.shape[:2]
    ih, iw = inp.shape[:2]
    sx = iw / ow
    sy = ih / oh
    px = (np.arange(ow) + 0.5) * sx - 0.5
    py = (np.arange(oh) + 0.5) * sy - 0.5
    x0 = np.clip(np.floor(px).astype(int), 0, iw - 1)
    x1 = np.clip(x0 + 1, 0, iw - 1)
    y0 = np.clip(np.floor(py).astype(int), 0, ih - 1)
    y1 = np.clip(y0 + 1, 0, ih - 1)
    a = inp[y0][:, x0]
    b = inp[y0][:, x1]
    c = inp[y1][:, x0]
    d = inp[y1][:, x1]
    lo = np.minimum(np.minimum(a, b), np.minimum(c, d))
    hi = np.maximum(np.maximum(a, b), np.maximum(c, d))
    over = (out > hi + tol) | (out < lo - tol)
    return float(over.any(axis=2).mean())


def measure(gt, inp, out):
    if out.shape != gt.shape:
        raise SystemExit("size %s != ground truth %s" % (out.shape, gt.shape))
    h, w = gt.shape[:2]
    cy0, cy1 = h // 3, 2 * h // 3
    cx0, cx1 = w // 3, 2 * w // 3
    r = {
        "psnr": float(peak_signal_noise_ratio(gt, out, data_range=1.0)),
        "ssim": float(structural_similarity(gt, out, data_range=1.0, channel_axis=2,
                                            gaussian_weights=True, sigma=1.5, use_sample_covariance=False)),
        "ssimY": float(structural_similarity(luma(gt), luma(out), data_range=1.0,
                                             gaussian_weights=True, sigma=1.5, use_sample_covariance=False)),
        "overshoot": overshoot(out, inp),
        "centre": {
            "psnr": float(peak_signal_noise_ratio(gt[cy0:cy1, cx0:cx1], out[cy0:cy1, cx0:cx1], data_range=1.0)),
            "ssim": float(structural_similarity(gt[cy0:cy1, cx0:cx1], out[cy0:cy1, cx0:cx1], data_range=1.0,
                                                channel_axis=2, gaussian_weights=True, sigma=1.5,
                                                use_sample_covariance=False)),
        },
        "flip": None,
    }
    if flip is not None:
        try:
            err_map, mean, _ = flip.evaluate(gt, out, "LDR")
            r["flip"] = float(mean)
            r["flipP99"] = float(np.percentile(err_map, 99))
        except Exception as e:  # noqa: BLE001
            r["flipError"] = str(e)
    return r


def fmt(x, d=3):
    return ("%.*f" % (d, x)) if isinstance(x, (int, float)) else "-"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gt", required=True)
    ap.add_argument("--input", required=True, help="the reduced input the cells read")
    ap.add_argument("outputs", nargs="+")
    ap.add_argument("--json", default="")
    ap.add_argument("--md", default="")
    a = ap.parse_args()
    gt = load(a.gt)
    inp = load(a.input)
    rows = []
    print("%-28s %7s %7s %7s %9s | centre %7s %7s | %6s %6s" % (
        "output", "PSNR", "SSIM", "SSIM Y", "overshoot", "PSNR", "SSIM", "FLIP", "p99"))
    for path in a.outputs:
        r = measure(gt, inp, load(path))
        r["file"] = os.path.basename(path)
        rows.append(r)
        print("%-28s %7.2f %7.4f %7.4f %8.2f%% | centre %7.2f %7.4f | %6s %6s" % (
            r["file"][:28], r["psnr"], r["ssim"], r["ssimY"], 100 * r["overshoot"],
            r["centre"]["psnr"], r["centre"]["ssim"], fmt(r["flip"]), fmt(r.get("flipP99"))))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"gt": a.gt, "input": a.input, "rows": rows}, f, indent=1)
    if a.md:
        lines = ["| output | PSNR dB | SSIM | SSIM Y | overshoot % | centre PSNR | centre SSIM | FLIP | FLIP p99 |",
                 "|---|---|---|---|---|---|---|---|---|"]
        for r in rows:
            lines.append("| %s | %.2f | %.4f | %.4f | %.2f | %.2f | %.4f | %s | %s |" % (
                r["file"], r["psnr"], r["ssim"], r["ssimY"], 100 * r["overshoot"],
                r["centre"]["psnr"], r["centre"]["ssim"], fmt(r["flip"]), fmt(r.get("flipP99"))))
        with open(a.md, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    if flip is None:
        print("(flip-evaluator not importable: FLIP left empty)")


if __name__ == "__main__":
    main()
