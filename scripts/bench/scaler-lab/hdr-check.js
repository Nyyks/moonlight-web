// mwsr on an HDR stream (PQ, BT.2020, 10-bit Y'CbCr frames), through the
// product's WebGpuRenderer, on the software adapter; driven by hdr_check.py.
// Each case of /__dir/hdr-cases.json is drawn on the renderer's two HDR
// readback paths, 'linear' (the rgba16float canvas, mwsr on float
// intermediates) and 'tonemap' (ACES, then mwsr on 8-bit), with:
//   - 'off', the plain copy, and 'mwsr', the product's;
//   - 'mwsr-ll2' on a reduction on 'linear': the reduction in exact sRGB
//     light (LINEAR_LIGHT 2) instead of the product's square, a diagnostic;
//   - 'mwsr-f32' where the device has shader-f16: the f32 kernel beside the
//     f16 one the renderer picked.
// The canvas texture is a texture of the canvas' own format, so that the
// picture is read back whole (half floats on 'linear'); it is posted to
// /__bin as RGBA half floats for the driver to measure. The page refuses any
// adapter but SwiftShader before it asks for a device. Its answer is left in
// window.__done, its progress in window.__progress.
import { mwsrRegime } from "../../../frontend/js/stream/renderers/MwsrShader.js";
import { WebGpuRenderer } from "../../../frontend/js/stream/renderers/WebGpuRenderer.js";

const T = GPUTextureUsage;
const B = GPUBufferUsage;

/** The texture's pixels as RGBA half floats (rows packed), 8-bit ones in [0, 1]. */
async function readTarget(device, tex) {
  const w = tex.width;
  const h = tex.height;
  const half = tex.format === "rgba16float";
  const bpp = half ? 8 : 4;
  const row = Math.ceil((w * bpp) / 256) * 256;
  const buf = device.createBuffer({ size: row * h, usage: B.COPY_DST | B.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w, h]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  let out;
  if (half) {
    out = new Uint8Array(w * h * 8);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * row, y * row + w * 8), y * w * 8);
  } else {
    const f = new Float16Array(w * h * 4);
    const [ri, bi] = tex.format.startsWith("bgra") ? [2, 0] : [0, 2];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * row + x * 4;
        const d = (y * w + x) * 4;
        f[d] = src[s + ri] / 255;
        f[d + 1] = src[s + 1] / 255;
        f[d + 2] = src[s + bi] / 255;
        f[d + 3] = 1;
      }
    }
    out = new Uint8Array(f.buffer);
  }
  buf.unmap();
  buf.destroy();
  return out;
}

/** One frame of case c drawn by a renderer made for mode and variant. */
async function drawOnce(c, planes, mode, variant) {
  const canvas = new OffscreenCanvas(16, 16);
  const r = await WebGpuRenderer.create(canvas, {
    algo: variant === "off" ? "off" : "mwsr",
    hdr: mode === "linear",
    hdrLinear: mode === "linear",
    hdrTonemap: mode === "tonemap",
    yuv444: c.chroma === "444",
    videoCodec: "hevc",
  });
  const errors = [];
  r._device.addEventListener("uncapturederror", (e) => errors.push(String(e.error.message)));
  const cfg = {
    hdr: r._hdr,
    hdrLinear: r._hdrLinear,
    format: r._format,
    inter: r._interFormat,
    srgbViews: r._srgbViews,
    half: r._mwsrHalf,
  };
  if (variant === "mwsr-f32") {
    // the same kernel in f32: its pipelines rebuilt as they are asked for
    r._mwsrHalf = false;
    r._mwsrPipelines = new Map();
    cfg.half = false;
  }
  let light = null;
  if (variant === "mwsr-ll2") {
    const pipeline = r._mwsrPipeline.bind(r);
    r._mwsrPipelines = new Map();
    r._mwsrPipeline = (reg) => pipeline(reg.mode === "down" ? { ...reg, linearLight: 2 } : reg);
    light = 2;
  }
  // The canvas texture: one of the canvas' format, whole for the readback.
  let target = null;
  r.ctx = {
    getCurrentTexture() {
      if (!target || target.width !== canvas.width || target.height !== canvas.height) {
        if (target) target.destroy();
        target = r._device.createTexture({
          size: [canvas.width, canvas.height],
          format: r._format,
          usage: T.RENDER_ATTACHMENT | T.COPY_SRC,
          viewFormats: r._srgbViews ? [r._format + "-srgb"] : [],
        });
      }
      return target;
    },
  };
  r.setOutputSize(c.out[0], c.out[1]);
  const [w, h] = c.in;
  const frame = new VideoFrame(planes, {
    format: c.chroma === "444" ? "I444P10" : "I420P10",
    codedWidth: w,
    codedHeight: h,
    timestamp: 1000,
    colorSpace: { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false },
  });
  await r.draw(frame);
  const res = {
    case: c.name,
    mode,
    variant,
    cfg,
    path: r.lastDraw ? r.lastDraw.path : null,
    size: [canvas.width, canvas.height],
    regime: mwsrRegime(w, h, canvas.width, canvas.height, { srgb: r._srgbViews }),
    errors,
    failed: r.failed,
    dump: ["hdr", c.name, mode, variant].join("-"),
  };
  if (light !== null && res.regime.mode === "down") res.regime.linearLight = light;
  if (!target) throw new Error("nothing was drawn");
  const bytes = await readTarget(r._device, target);
  const post = await fetch("/__bin?name=" + encodeURIComponent(res.dump), { method: "POST", body: bytes });
  if (!post.ok) throw new Error("posting " + res.dump + ": HTTP " + post.status);
  target.destroy();
  r.dispose();
  return res;
}

async function main() {
  if (typeof Float16Array !== "function") throw new Error("no Float16Array in this browser");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no adapter");
  const info = adapter.info || {};
  const name = [info.vendor, info.architecture, info.device, info.description].join(" ");
  if (!/swiftshader/i.test(name)) throw new Error("not the software adapter: " + name);
  const f16 = adapter.features.has("shader-f16");

  const cases = await (await fetch("/__dir/hdr-cases.json")).json();
  const results = [];
  let n = 0;
  for (const c of cases) {
    n++;
    const planes = new Uint8Array(await (await fetch("/__dir/" + c.yuv)).arrayBuffer());
    const down = c.out[0] < c.in[0];
    for (const mode of ["linear", "tonemap"]) {
      const variants = ["off", "mwsr"];
      if (mode === "linear" && down) variants.push("mwsr-ll2");
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        window.__progress = `case ${n}/${cases.length} ${c.name} ${mode} ${variant}`;
        let res;
        try {
          res = await drawOnce(c, planes, mode, variant);
        } catch (e) {
          res = { case: c.name, mode, variant, error: String((e && e.stack) || e) };
        }
        results.push(res);
        // the f32 kernel beside an f16 one
        if (variant === "mwsr" && mode === "linear" && res.cfg && res.cfg.half) variants.splice(i + 1, 0, "mwsr-f32");
      }
    }
  }
  return { ok: true, adapter: name, f16, results };
}

main()
  .then((r) => {
    window.__done = r;
  })
  .catch((e) => {
    window.__done = { ok: false, error: String((e && e.stack) || e) };
  });
