// The upscaler laboratory of the v0.4.1 plan (docs/design/upscaler-mwsr.md,
// §6.1, §6.4 and §7): the same pictures through N cells, each cell a chain of
// full-screen passes, timed by the GPU's own timestamps (timestamp-query),
// batched so that the fence round trip never enters the figure.
//
// Driven by scaler-lab.html, whose query carries the parameters:
//   in=1280x720 out=2560x1440   input and output sizes (16:9 both, as a stream)
//   content=text|ui|game|img:<url>  the picture (drawn by the page, or fetched)
//   set=feed,base,chain          which cells (see CELL_SETS), or cells=a,b,c
//   codec=avc|none               VideoFrames from a WebCodecs encode → decode
//                                loop (the external-texture feed), or none
//   pace=back|tick period=16.67  back to back, or one iteration per period
//   batch=16 batches=8 warm=2 rounds=3   the measurement (ABBA across rounds)
//   power=high-performance|low-power fallback=1   which adapter
//   f16=1                        ask for shader-f16 when the adapter has it
//   shot=1                       a crop of each cell's output, as PNG data URLs
//   post=1 tag=<name>            POST the result to the serving script
//
// Three feeds (§7.1, rule 1): `ext` reads the decoded VideoFrame through a
// texture_external (no pass 0); `tex` reads an rgba8unorm texture already
// materialised (the kernel alone); `blit+…` is pass 0 then the kernel, the
// chain the shipped WebGPU enhancers pay. `chain-*` drives the product's own
// WebGpuRenderer, unchanged, on an OffscreenCanvas, its passes timestamped
// from the outside (prototype hooks, nothing in the product).
//
// The reference shaders are read from the product's module text, so the lab
// always measures what ships (SGSR_WGSL, EASU_WGSL, RCAS_WGSL, NIS_WGSL,
// BLIT_WGSL). The "sgsr-src" cell is the same port with Qualcomm's published
// constants (threshold 8/255, sharpness 2.0, delta clamp ±23/255), the witness
// of §7.1 rule 6.
import {
  nisConfig,
  nisCoefTexture,
} from "/frontend/js/stream/renderers/NisTables.js";

const RENDERER_URL = "/frontend/js/stream/renderers/WebGpuRenderer.js";
const MWSR_URL = "/frontend/js/stream/renderers/MwsrShader.js";

const CELL_SETS = {
  feed: [
    "blit",
    "ext-s1",
    "ext-s5",
    "ext-s9",
    "ext-l1",
    "ext-l5",
    "ext-s1-fw",
    "tex-s1",
    "tex-s2",
    "tex-s5",
    "tex-s9",
    "tex-s1-fw",
    "blit+tex-s1",
    "blit+tex-s5",
    "blit+tex-s9",
  ],
  base: [
    "sgsr-repo",
    "sgsr-src",
    "nis",
    "easu",
    "rcas",
    "fsr1",
    "blit+sgsr-repo",
    "blit+fsr1",
  ],
  chain: ["chain-off", "chain-sgsr", "chain-nis", "chain-fsr1"],
  // The mwsr kernel (plan §3.2): `mwsr[:key=val;key=val…]` sets its
  // overrides (show, walong, wacross, ralong, racross, sfull, wmin, dering),
  // uniforms (tau, sharp) and half=1 (the f16 module; the page needs f16=1)
  // and uniforms (tau, sharp); `ext-mwsr` reads the external texture (no
  // pass 0), `blit+mwsr` pays the pass 0 first.
  mwsr: ["mwsr", "mwsr:dering=0", "mwsr:half=1", "blit+mwsr"],
};

const VS = /* wgsl */ `
struct VSOut {
    @builtin(position) pos : vec4f,
    @location(0) uv : vec2f,
};
@vertex
fn vs(@builtin(vertex_index) vid : u32) -> VSOut {
    var out : VSOut;
    let uv = vec2f(f32((vid << 1u) & 2u), f32(vid & 2u));
    out.uv = uv;
    out.pos = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    return out;
}
`;

// N bilinear samples (a cross at one texel, then the diagonals) averaged, on
// an external texture or an ordinary one, by sample or by load; `fw` adds the
// screen derivative of the luma (the vote of §3.2) to one sample. The average
// keeps every sample alive in the compiled code.
function tapsShader(feed, n, mode, fw) {
  const ext = feed === "ext";
  const decl = ext
    ? "var tex : texture_external;"
    : "var tex : texture_2d<f32>;";
  const sample =
    mode === "l"
      ? ext
        ? `fn S(uv : vec2f, off : vec2f) -> vec3f {
    let d = vec2i(textureDimensions(tex));
    let c = clamp(vec2i(uv * vec2f(d)) + vec2i(off), vec2i(0), d - vec2i(1));
    return textureLoad(tex, c).rgb;
}`
        : `fn S(uv : vec2f, off : vec2f) -> vec3f {
    let d = vec2i(textureDimensions(tex));
    let c = clamp(vec2i(uv * vec2f(d)) + vec2i(off), vec2i(0), d - vec2i(1));
    return textureLoad(tex, c, 0).rgb;
}`
      : ext
        ? `fn S(uv : vec2f, off : vec2f) -> vec3f {
    return textureSampleBaseClampToEdge(tex, samp, uv + off * u.texel).rgb;
}`
        : `fn S(uv : vec2f, off : vec2f) -> vec3f {
    return textureSampleLevel(tex, samp, uv + off * u.texel, 0.0).rgb;
}`;
  const offs = [
    [0, 0],
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].slice(0, n);
  const sum = offs
    .map(([x, y]) => `S(in.uv, vec2f(${x}.0, ${y}.0))`)
    .join(" + ");
  const body = fw
    ? `let c = ${sum};
    let l = dot(c, vec3f(0.25, 0.5, 0.25));
    let w = fwidth(l);
    return vec4f(c / ${n}.0 + vec3f(w), 1.0);`
    : `let c = ${sum};
    return vec4f(c / ${n}.0, 1.0);`;
  return (
    VS +
    `
struct U { texel : vec2f, pad : vec2f };
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) ${decl}
@group(0) @binding(2) var<uniform> u : U;
${sample}
@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
    ${body}
}
`
  );
}

// A WGSL template literal of the product's renderer module, by the name of
// its const; the ones built on FULLSCREEN_VS get it prepended as the module does.
function extractWgsl(src, name) {
  const at = src.indexOf("const " + name);
  if (at < 0) throw new Error(name + " not found in " + RENDERER_URL);
  const b0 = src.indexOf("`", at);
  const b1 = src.indexOf("`", b0 + 1);
  const head = src.slice(at, b0);
  const body = src.slice(b0 + 1, b1);
  if (body.includes("${"))
    throw new Error(
      name + " has an interpolation; the extractor cannot read it",
    );
  return head.includes("FULLSCREEN_VS +")
    ? extractWgsl(src, "FULLSCREEN_VS") + body
    : body;
}

function sgsrSource(repo) {
  const edits = [
    ["6.0 / 255.0", "8.0 / 255.0"],
    ["EDGE_SHARPNESS : f32 = 1.5", "EDGE_SHARPNESS : f32 = 2.0"],
    [
      "let deltaY = finalY - pixW;",
      "let deltaY = clamp(finalY - pixW, -23.0 / 255.0, 23.0 / 255.0);",
    ],
  ];
  let s = repo;
  for (const [a, b] of edits) {
    if (!s.includes(a))
      throw new Error('sgsr-src: "' + a + '" not found in the port');
    s = s.replace(a, b);
  }
  return s;
}

// ── the pictures ───────────────────────────────────────────────────────────

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawText(ctx, w, h) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  const px = Math.max(9, Math.round(h / 60));
  ctx.font = px + "px Georgia, serif";
  ctx.fillStyle = "#111";
  const words = (
    "the quick brown fox jumps over the lazy dog while distant thunder rolls across " +
    "an empty plain and the lantern gutters in a wind that smells of rain and iron "
  ).split(" ");
  const cols = 3;
  const gap = Math.round(w * 0.03);
  const colW = (w - gap * (cols + 1)) / cols;
  let wi = 0;
  for (let c = 0; c < cols; c++) {
    let y = gap + px;
    while (y < h - gap) {
      let line = "";
      while (true) {
        const next = line + words[wi % words.length] + " ";
        if (ctx.measureText(next).width > colW) break;
        line = next;
        wi++;
      }
      ctx.fillStyle = c === 1 && y % 7 < 2 ? "#1a4fd6" : "#111";
      ctx.fillText(line, gap + c * (colW + gap), y);
      y += Math.round(px * 1.5);
    }
  }
}

function drawUi(ctx, w, h) {
  const rnd = mulberry(7);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#2b2f3a");
  g.addColorStop(1, "#14161c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const px = Math.max(9, Math.round(h / 54));
  ctx.font = px + "px system-ui, sans-serif";
  // a side bar, cards, a progress bar, thin lines, icons
  ctx.fillStyle = "#1d212b";
  ctx.fillRect(0, 0, Math.round(w * 0.18), h);
  for (let i = 0; i < 14; i++) {
    const y = Math.round(h * 0.06 + i * px * 2.2);
    ctx.fillStyle = i === 3 ? "#3b82f6" : "#8a93a6";
    ctx.fillRect(Math.round(w * 0.02), y - px, px, px);
    ctx.fillStyle = i === 3 ? "#fff" : "#c7cdd8";
    ctx.fillText(
      "Item " + (i + 1) + " — settings",
      Math.round(w * 0.02) + px * 1.6,
      y,
    );
  }
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) {
      const x = Math.round(w * 0.21 + c * w * 0.19);
      const y = Math.round(h * 0.08 + r * h * 0.29);
      const cw = Math.round(w * 0.17);
      const ch = Math.round(h * 0.24);
      ctx.fillStyle = "#272c38";
      ctx.fillRect(x, y, cw, ch);
      ctx.strokeStyle = "#3a4152";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
      ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)}, 60%, 55%)`;
      ctx.beginPath();
      ctx.arc(x + px * 1.5, y + px * 1.5, px * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e6e9ef";
      ctx.fillText("Card " + (r * 4 + c + 1), x + px * 3, y + px * 1.9);
      ctx.fillStyle = "#9aa3b5";
      ctx.font = Math.round(px * 0.8) + "px system-ui, sans-serif";
      ctx.fillText("1 920 × 1 080 · 60 fps · 20 Mbit/s", x + px, y + px * 3.4);
      ctx.font = px + "px system-ui, sans-serif";
      ctx.fillStyle = "#1a1e27";
      ctx.fillRect(x + px, y + ch - px * 2, cw - px * 2, px * 0.6);
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(x + px, y + ch - px * 2, (cw - px * 2) * rnd(), px * 0.6);
      for (let k = 0; k < 6; k++) {
        ctx.fillStyle = k % 2 ? "#3a4152" : "#5a6478";
        ctx.fillRect(x + px + k * px * 1.2, y + px * 4.5, px * 0.9, 1);
      }
    }
}

// A landscape with soft gradients, sharp silhouettes and a HUD: the mix of a
// game picture (flat regions, a few hard edges, text on top).
function drawGame(ctx, w, h) {
  const rnd = mulberry(11);
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, "#1b2a6b");
  sky.addColorStop(0.6, "#f0906a");
  sky.addColorStop(1, "#ffd9a0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const sun = ctx.createRadialGradient(
    w * 0.7,
    h * 0.5,
    0,
    w * 0.7,
    h * 0.5,
    h * 0.12,
  );
  sun.addColorStop(0, "#fff6d6");
  sun.addColorStop(1, "rgba(255,220,160,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  for (let layer = 0; layer < 4; layer++) {
    const base = h * (0.5 + layer * 0.11);
    const amp = h * (0.08 - layer * 0.012);
    ctx.fillStyle = `hsl(${120 + layer * 10}, ${30 + layer * 8}%, ${12 + layer * 9}%)`;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const t = x / w;
      const y =
        base -
        amp *
          (Math.sin(t * 7 + layer) * 0.5 +
            Math.sin(t * 19 + layer * 3) * 0.3 +
            Math.sin(t * 53) * 0.2);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.fill();
    // trees: thin triangles, the hard edges
    ctx.fillStyle = `hsl(${110 + layer * 10}, 35%, ${8 + layer * 6}%)`;
    for (let k = 0; k < 40 - layer * 6; k++) {
      const x = rnd() * w;
      const t = x / w;
      const y =
        base -
        amp *
          (Math.sin(t * 7 + layer) * 0.5 +
            Math.sin(t * 19 + layer * 3) * 0.3 +
            Math.sin(t * 53) * 0.2);
      const s = h * (0.05 - layer * 0.008) * (0.6 + rnd() * 0.8);
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x - s * 0.3, y + s * 0.1);
      ctx.lineTo(x + s * 0.3, y + s * 0.1);
      ctx.fill();
    }
  }
  // film grain, the noise a codec fights
  const img = ctx.getImageData(
    0,
    Math.round(h * 0.55),
    w,
    Math.round(h * 0.45),
  );
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 18;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, Math.round(h * 0.55));
  // HUD
  const px = Math.max(10, Math.round(h / 40));
  ctx.font = "bold " + px + "px system-ui, sans-serif";
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(px, px, px * 14, px * 2.2);
  ctx.fillStyle = "#fff";
  ctx.fillText("HP 87   AMMO 24/120", px * 1.5, px * 2.5);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(1, px / 10);
  ctx.beginPath();
  ctx.moveTo(w / 2 - px, h / 2);
  ctx.lineTo(w / 2 + px, h / 2);
  ctx.moveTo(w / 2, h / 2 - px);
  ctx.lineTo(w / 2, h / 2 + px);
  ctx.stroke();
}

// The reduction test pattern (§7.1, C10): a zone plate on the left (every
// spatial frequency up to Nyquist, where aliasing shows as moiré), gratings of
// 1 to 6 px period on the right, and thin diagonal lines.
function drawZone(ctx, w, h) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const half = Math.floor(w / 2);
  const cx = half / 2;
  const cy = h / 2;
  const kmax = Math.PI / Math.max(cx, cy); // Nyquist at the edge
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v;
      if (x < half) {
        const dx = x - cx;
        const dy = y - cy;
        v = 0.5 + 0.5 * Math.cos((kmax * (dx * dx + dy * dy)) / 2);
      } else {
        const band = Math.floor(((y / h) * 6) % 6); // period 1..6 px
        const period = band + 1;
        v = Math.floor((x - half) / period) % 2 ? 0.9 : 0.1;
        if (band === 5) v = Math.floor(y / period) % 2 ? 0.9 : 0.1;
      }
      const i = (y * w + x) * 4;
      const g = Math.round(v * 255);
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  for (let k = 0; k < 8; k++) {
    ctx.beginPath();
    ctx.moveTo(half + 10 + k * 30, h - 10);
    ctx.lineTo(w - 10, h * 0.1 + k * 12);
    ctx.stroke();
  }
}

// Coloured syntax on a dark background: text whose edges live in the chroma
// as much as in the luma (§4.2, C9).
function drawCode(ctx, w, h) {
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, w, h);
  const px = Math.max(9, Math.round(h / 56));
  ctx.font = px + "px Consolas, monospace";
  const colors = {
    kw: "#569cd6",
    str: "#ce9178",
    cmt: "#6a9955",
    id: "#9cdcfe",
    num: "#b5cea8",
    fn: "#dcdcaa",
    pl: "#d4d4d4",
  };
  const lines = [
    [
      ["kw", "const "],
      ["id", "frame "],
      ["pl", "= "],
      ["kw", "await "],
      ["fn", "decode"],
      ["pl", "(chunk, "],
      ["num", "16667"],
      ["pl", ");"],
    ],
    [["cmt", "// the external texture expires with the frame"]],
    [
      ["kw", "for "],
      ["pl", "("],
      ["kw", "let "],
      ["id", "i "],
      ["pl", "= "],
      ["num", "0"],
      ["pl", "; i < "],
      ["id", "n"],
      ["pl", "; i++) {"],
    ],
    [
      ["pl", "    "],
      ["id", "pass"],
      ["pl", "."],
      ["fn", "setBindGroup"],
      ["pl", "("],
      ["num", "0"],
      ["pl", ", "],
      ["fn", "bind"],
      ["pl", "(ext));"],
    ],
    [
      ["pl", "    "],
      ["id", "log"],
      ["pl", "("],
      ["str", "'gpu p50 ' "],
      ["pl", "+ "],
      ["id", "t"],
      ["pl", "."],
      ["fn", "toFixed"],
      ["pl", "("],
      ["num", "3"],
      ["pl", "));"],
    ],
    [["pl", "}"]],
  ];
  const lh = Math.round(px * 1.45);
  let y = px * 2;
  let n = 0;
  // Two columns: the lines are short, and with one column the central third
  // of the picture (where the metrics also look) held no text at all (P0 §6).
  while (y < h - px) {
    const line = lines[n % lines.length];
    for (const x0 of [px, Math.round(w * 0.5)]) {
      let x = x0;
      ctx.fillStyle = "#858585";
      ctx.fillText(String(n + 1).padStart(3), x, y);
      x += px * 3;
      for (const [kind, text] of line) {
        ctx.fillStyle = colors[kind];
        ctx.fillText(text, x, y);
        x += ctx.measureText(text).width;
      }
    }
    y += lh;
    n++;
  }
}

async function makePicture(kind, w, h, k) {
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", {
    alpha: false,
    willReadFrequently: kind === "game",
  });
  if (kind.startsWith("img:")) {
    const url = kind.slice(4);
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ": " + r.status);
    const bmp = await createImageBitmap(await r.blob());
    const s = Math.max(w / bmp.width, h / bmp.height);
    const dw = bmp.width * s;
    const dh = bmp.height * s;
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
    bmp.close();
  } else if (kind === "ui") drawUi(ctx, w, h);
  else if (kind === "game") drawGame(ctx, w, h);
  else if (kind === "zone") drawZone(ctx, w, h);
  else if (kind === "code") drawCode(ctx, w, h);
  else drawText(ctx, w, h);
  // frame k: a small moving square, so that an encoded clip has P-frames
  // with motion and the artefacts of a real stream (still.html's anim).
  if (k > 0) {
    const s = Math.round(h / 24);
    ctx.fillStyle = "#c22";
    ctx.fillRect(w - s * 3 - k * 7, h - s * 3, s, s);
  }
  return cv;
}

// ── the video frames ───────────────────────────────────────────────────────

async function makeFrames(pictures, codec, log) {
  const w = pictures[0].width;
  const h = pictures[0].height;
  const codecString = codec === "hevc" ? "hvc1.1.6.L120.B0" : "avc1.640032";
  const chunks = [];
  const encConfig = {
    codec: codecString,
    width: w,
    height: h,
    bitrate: 20_000_000,
    framerate: 60,
    latencyMode: "realtime",
    hardwareAcceleration: "prefer-hardware",
  };
  if (codec !== "hevc") encConfig.avc = { format: "annexb" };
  else encConfig.hevc = { format: "annexb" };
  let sup = await VideoEncoder.isConfigSupported(encConfig);
  if (!sup.supported) {
    encConfig.hardwareAcceleration = "no-preference";
    sup = await VideoEncoder.isConfigSupported(encConfig);
    if (!sup.supported) throw new Error("no encoder for " + codecString);
  }
  const encHw = encConfig.hardwareAcceleration;
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk) => chunks.push(chunk),
    error: (e) => {
      encErr = e;
    },
  });
  encoder.configure(encConfig);
  for (let k = 0; k < pictures.length; k++) {
    const vf = new VideoFrame(pictures[k], {
      timestamp: k * 16667,
      duration: 16667,
    });
    encoder.encode(vf, { keyFrame: k === 0 });
    vf.close();
  }
  await encoder.flush();
  encoder.close();
  if (encErr) throw new Error("encoder: " + encErr.message);
  const decConfig = {
    codec: codecString,
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  };
  let dsup = await VideoDecoder.isConfigSupported(decConfig);
  if (!dsup.supported) {
    decConfig.hardwareAcceleration = "no-preference";
    dsup = await VideoDecoder.isConfigSupported(decConfig);
    if (!dsup.supported) throw new Error("no decoder for " + codecString);
  }
  const frames = [];
  let decErr = null;
  const decoder = new VideoDecoder({
    output: (f) => {
      if (frames.length < 6) frames.push(f);
      else f.close();
    },
    error: (e) => {
      decErr = e;
    },
  });
  decoder.configure(decConfig);
  for (const c of chunks) decoder.decode(c);
  await decoder.flush();
  decoder.close();
  if (decErr) throw new Error("decoder: " + decErr.message);
  if (!frames.length) throw new Error("no decoded frame");
  const f0 = frames[0];
  const bytes = chunks.reduce((a, c) => a + c.byteLength, 0);
  const info = {
    codec: codecString,
    encoderAcceleration: encHw,
    decoderAcceleration: decConfig.hardwareAcceleration,
    format: f0.format,
    coded: f0.codedWidth + "x" + f0.codedHeight,
    display: f0.displayWidth + "x" + f0.displayHeight,
    colorSpace: f0.colorSpace
      ? {
          primaries: f0.colorSpace.primaries,
          transfer: f0.colorSpace.transfer,
          matrix: f0.colorSpace.matrix,
          fullRange: f0.colorSpace.fullRange,
        }
      : null,
    frames: frames.length,
    kbitPerFrame: Math.round((bytes * 8) / chunks.length / 1000),
  };
  log("frames: " + JSON.stringify(info));
  return { frames, info };
}

// ── statistics ─────────────────────────────────────────────────────────────

function quant(xs, f) {
  const s = xs
    .filter((x) => x !== null && !Number.isNaN(x))
    .sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
}
function stats(xs) {
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: xs.length,
    p50: quant(xs, 0.5),
    p90: quant(xs, 0.9),
    p99: quant(xs, 0.99),
    mean,
  };
}

// ── the lab ────────────────────────────────────────────────────────────────

export async function runLab(p, log = () => {}) {
  const [inW, inH] = (p.in || "1280x720").split("x").map(Number);
  const [outW, outH] = (p.out || "2560x1440").split("x").map(Number);
  const content = p.content || "text";
  const codec = p.codec || "avc";
  const pace = p.pace || "back";
  const period = Number(p.period || 1000 / 60);
  const flip = p.flip === "1";
  const batch = Number(p.batch || 16);
  const batches = Number(p.batches || 8);
  const warm = Number(p.warm || 2);
  const rounds = Number(p.rounds || 3);
  const wantShots = p.shot === "1";
  const sets = (p.set || "feed,base").split(",").filter(Boolean);
  const cellNames = p.cells
    ? p.cells.split(",")
    : sets.flatMap((s) => CELL_SETS[s] || []);
  const errors = [];

  // gt=1: the ground truth, the same picture at the output size, posted as PNG
  // to the serving script, which reduces it (Lanczos-3, linear light) into the
  // input of the quality runs (§7.1, rule 2). Nothing else is done.
  if (p.gt === "1") {
    const cv = await makePicture(content, outW, outH, 0);
    const blob = await cv.convertToBlob({ type: "image/png" });
    const name = (p.tag || "lab") + "-gt";
    await postBlob("/__png?name=" + encodeURIComponent(name), blob);
    log("ground truth posted: " + name);
    return { gt: name, params: { out: `${outW}x${outH}`, content } };
  }
  // dump=base|all|a,b,c: after the measurement, each of these cells rendered
  // once more and its whole output posted as PNG (for metrics.py).
  const dumpList =
    p.dump === "all"
      ? cellNames.filter((c) => !c.startsWith("chain"))
      : p.dump === "base"
        ? ["tex-s1", "sgsr-repo", "sgsr-src", "nis", "easu", "fsr1", "mwsr"].filter(
            (c) => cellNames.includes(c),
          )
        : (p.dump || "").split(",").filter(Boolean);

  if (!navigator.gpu) throw new Error("no WebGPU (navigator.gpu)");
  // The product's renderer asks for the default adapter and a bare device:
  // the hooks give it the same adapter as the lab and the timestamp feature,
  // and stamp its render passes from the outside (chain-* cells).
  const adapterOpts = {};
  if (p.power) adapterOpts.powerPreference = p.power;
  if (p.fallback === "1") adapterOpts.forceFallbackAdapter = true;
  installHooks(adapterOpts);
  const adapter = await navigator.gpu.requestAdapter(adapterOpts);
  if (!adapter) throw new Error("requestAdapter returned null");
  const info = adapter.info || {};
  const features = [...adapter.features].sort();
  const hasTs = adapter.features.has("timestamp-query");
  const hasF16 = adapter.features.has("shader-f16");
  const required = [];
  if (hasTs) required.push("timestamp-query");
  if (hasF16 && p.f16 === "1") required.push("shader-f16");
  const device = await adapter.requestDevice({ requiredFeatures: required });
  device.onuncapturederror = (e) => errors.push(e.error.message);
  const adapterName =
    `${info.vendor || "?"} ${info.architecture || ""} ${info.device || ""} ${info.description || ""}`
      .replace(/\s+/g, " ")
      .trim();
  log(
    `adapter: ${adapterName} | timestamps ${hasTs} f16 ${hasF16} | features ${features.join(" ")}`,
  );
  const format = navigator.gpu.getPreferredCanvasFormat();

  // Pictures: F frames of the content at the input size (the clip), and the
  // first one as the materialised texture.
  const F = 12;
  const pictures = [];
  for (let k = 0; k < F; k++)
    pictures.push(await makePicture(content, inW, inH, k));
  let frames = [];
  let frameInfo = null;
  const needExt = cellNames.some(
    (c) => c.startsWith("ext") || c.startsWith("blit") || c.startsWith("chain"),
  );
  if (codec !== "none" && needExt) {
    try {
      const r = await makeFrames(pictures, codec, log);
      frames = r.frames;
      frameInfo = r.info;
    } catch (e) {
      errors.push("frames: " + e.message);
      log("frames failed: " + e.message);
    }
  }

  const mkTex = (w, h, fmt, usage) =>
    device.createTexture({ size: { width: w, height: h }, format: fmt, usage });
  const T = GPUTextureUsage;
  const inTex = mkTex(
    inW,
    inH,
    "rgba8unorm",
    T.TEXTURE_BINDING | T.COPY_DST | T.RENDER_ATTACHMENT,
  );
  device.queue.copyExternalImageToTexture(
    { source: pictures[0] },
    { texture: inTex },
    { width: inW, height: inH },
  );
  const blitTex = mkTex(
    inW,
    inH,
    "rgba8unorm",
    T.TEXTURE_BINDING | T.RENDER_ATTACHMENT,
  );
  const midTex = mkTex(
    outW,
    outH,
    "rgba8unorm",
    T.TEXTURE_BINDING | T.RENDER_ATTACHMENT,
  );
  const intermTex = mkTex(
    outW,
    outH,
    "rgba8unorm",
    T.TEXTURE_BINDING | T.RENDER_ATTACHMENT,
  );
  const outTex = mkTex(outW, outH, format, T.RENDER_ATTACHMENT | T.COPY_SRC);
  const views = {
    blit: blitTex.createView(),
    interm: intermTex.createView(),
    mid: midTex.createView(),
    out: outTex.createView(),
  };
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const uniform = (arr) => {
    const b = device.createBuffer({
      size: Math.max(16, arr.byteLength),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(b, 0, arr);
    return b;
  };
  const texelIn = uniform(new Float32Array([1 / inW, 1 / inH, 0, 0]));
  const texelOut = uniform(new Float32Array([1 / outW, 1 / outH, 0, 0]));

  const src = await (await fetch(RENDERER_URL)).text();
  const SH = {
    blit: extractWgsl(src, "BLIT_WGSL"),
    sgsr: extractWgsl(src, "SGSR_WGSL"),
    nis: extractWgsl(src, "NIS_WGSL"),
    easu: extractWgsl(src, "EASU_WGSL"),
    rcas: extractWgsl(src, "RCAS_WGSL"),
  };
  SH.sgsrSrc = sgsrSource(SH.sgsr);
  const { mwsrWgsl, mwsrUniforms } = await import(MWSR_URL);

  const pipelines = new Map();
  const pipeline = (
    key,
    code,
    target,
    entry = ["vs", "fs"],
    layout = "auto",
    constants = undefined,
  ) => {
    if (pipelines.has(key)) return pipelines.get(key);
    const module = device.createShaderModule({ code });
    const pl = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: entry[0] },
      fragment: {
        module,
        entryPoint: entry[1],
        targets: [{ format: target === "out" ? format : "rgba8unorm" }],
        constants,
      },
      primitive: { topology: "triangle-list" },
    });
    pipelines.set(key, pl);
    return pl;
  };
  const bind = (pl, entries) =>
    device.createBindGroup({
      layout: pl.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource })),
    });
  // Explicit layouts for the lab's own shaders: an `auto` layout drops a
  // binding the code does not use (the sampler of a load, the texel size of
  // a load), and the bind group would then be refused.
  const FR = GPUShaderStage.FRAGMENT;
  const L = (entries) =>
    device.createPipelineLayout({
      bindGroupLayouts: [device.createBindGroupLayout({ entries })],
    });
  const plExt = L([
    { binding: 0, visibility: FR, sampler: {} },
    { binding: 1, visibility: FR, externalTexture: {} },
    { binding: 2, visibility: FR, buffer: {} },
  ]);
  const plTex = L([
    { binding: 0, visibility: FR, sampler: {} },
    { binding: 1, visibility: FR, texture: { sampleType: "float" } },
    { binding: 2, visibility: FR, buffer: {} },
  ]);
  const plBlit = L([
    { binding: 0, visibility: FR, sampler: {} },
    { binding: 1, visibility: FR, externalTexture: {} },
  ]);

  // Reference kernels, on a texture already materialised (`tex`: inTex; after
  // a blit: blitTex), each a pass to `out`.
  const sgsrU = uniform(new Float32Array([1 / inW, 1 / inH, inW, inH]));
  const easuU = uniform(new Float32Array([inW, inH, outW, outH]));
  const rcasU = uniform(new Float32Array([outW, outH, 1 / outW, 1 / outH]));
  const cfg = nisConfig(0.5);
  const nisU = uniform(
    new Float32Array([
      inW / outW,
      inH / outH,
      1 / inW,
      1 / inH,
      ...cfg.detect,
      ...cfg.sharpA,
      ...cfg.sharpB,
      outW,
      outH,
      0,
      0,
    ]),
  );
  const nisCoef = mkTex(4, 64, "rgba32float", T.TEXTURE_BINDING | T.COPY_DST);
  device.queue.writeTexture(
    { texture: nisCoef },
    nisCoefTexture(),
    { bytesPerRow: 64, rowsPerImage: 64 },
    { width: 4, height: 64 },
  );
  const nisLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" },
      },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
    ],
  });
  const nisPl = device.createPipelineLayout({ bindGroupLayouts: [nisLayout] });

  const inView = inTex.createView();
  const kernelPass = (name, srcView) => {
    switch (name) {
      case "sgsr-repo": {
        const pl = pipeline("sgsr-repo", SH.sgsr, "out");
        return {
          pipeline: pl,
          target: "out",
          group: bind(pl, [sampler, srcView, { buffer: sgsrU }]),
        };
      }
      case "sgsr-src": {
        const pl = pipeline("sgsr-src", SH.sgsrSrc, "out");
        return {
          pipeline: pl,
          target: "out",
          group: bind(pl, [sampler, srcView, { buffer: sgsrU }]),
        };
      }
      case "nis": {
        const pl = pipeline("nis", SH.nis, "out", ["vs", "fs"], nisPl);
        return {
          pipeline: pl,
          target: "out",
          group: device.createBindGroup({
            layout: nisLayout,
            entries: [
              { binding: 0, resource: sampler },
              { binding: 1, resource: srcView },
              { binding: 2, resource: nisCoef.createView() },
              { binding: 3, resource: { buffer: nisU } },
            ],
          }),
        };
      }
      case "easu": {
        const pl = pipeline("easu-out", SH.easu, "out", ["vs_main", "fs_main"]);
        return {
          pipeline: pl,
          target: "out",
          group: bind(pl, [srcView, sampler, { buffer: easuU }]),
        };
      }
      default:
        throw new Error("kernel " + name + "?");
    }
  };
  const easuToInterm = (srcView) => {
    const pl = pipeline("easu-interm", SH.easu, "interm", [
      "vs_main",
      "fs_main",
    ]);
    return {
      pipeline: pl,
      target: "interm",
      group: bind(pl, [srcView, sampler, { buffer: easuU }]),
    };
  };
  const rcasFrom = (srcView) => {
    const pl = pipeline("rcas", SH.rcas, "out", ["vs_main", "fs_main"]);
    return {
      pipeline: pl,
      target: "out",
      group: bind(pl, [srcView, sampler, { buffer: rcasU }]),
    };
  };
  const blitPass = () => {
    const pl = pipeline("blit", SH.blit, "blit", ["vs", "fs"], plBlit);
    return {
      pipeline: pl,
      target: "blit",
      ext: (ext) => bind(pl, [sampler, ext]),
    };
  };
  const tapsPass = (feed, n, mode, fw, srcView) => {
    const key = `${feed}-${mode}${n}${fw ? "-fw" : ""}`;
    const pl = pipeline(
      key,
      tapsShader(feed, n, mode, fw),
      "out",
      ["vs", "fs"],
      feed === "ext" ? plExt : plTex,
    );
    if (feed === "ext")
      return {
        pipeline: pl,
        target: "out",
        ext: (ext) => bind(pl, [sampler, ext, { buffer: texelIn }]),
      };
    return {
      pipeline: pl,
      target: "out",
      group: bind(pl, [sampler, srcView, { buffer: texelIn }]),
    };
  };

  // The mwsr kernel, one pass to `out`; the cell's options become overrides
  // (pipeline constants) and uniforms. The override defaults are the text's.
  const MWSR_KEYS = {
    show: "SHOW",
    walong: "W_ALONG",
    wacross: "W_ACROSS",
    ralong: "R_ALONG",
    racross: "R_ACROSS",
    sfull: "S_FULL",
    wmin: "W_MIN",
    dering: "DERING",
  };
  const mwsrPass = (name, feed, opts, srcView) => {
    const over = {};
    const uni = {};
    let half = false;
    for (const [k, v] of Object.entries(opts)) {
      if (k === "tau" || k === "sharp") uni[k] = Number(v);
      else if (k === "half") half = v === "1";
      else if (k in MWSR_KEYS) over[MWSR_KEYS[k]] = Number(v);
      else throw new Error(name + ": option " + k + "?");
    }
    if (half && !device.features.has("shader-f16"))
      throw new Error(name + ": the device has no shader-f16 (f16=1 asks for it)");
    const pl = pipeline(
      name,
      mwsrWgsl({ feed, half }),
      "out",
      ["vs", "fs"],
      feed === "ext" ? plExt : plTex,
      over,
    );
    const ub = uniform(mwsrUniforms(inW, inH, outW, outH, uni));
    if (feed === "ext")
      return {
        pipeline: pl,
        target: "out",
        ext: (ext) => bind(pl, [sampler, ext, { buffer: ub }]),
      };
    return {
      pipeline: pl,
      target: "out",
      group: bind(pl, [sampler, srcView, { buffer: ub }]),
    };
  };

  // midTex: the picture at the output size (a bilinear blit, once), the input
  // of the `rcas` cell alone, as RCAS reads EASU's output in the product.
  {
    const pl = pipeline(
      "mid",
      tapsShader("tex", 1, "s", false),
      "mid",
      ["vs", "fs"],
      plTex,
    );
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: views.mid, loadOp: "clear", storeOp: "store" },
      ],
    });
    pass.setPipeline(pl);
    pass.setBindGroup(0, bind(pl, [sampler, inView, { buffer: texelIn }]));
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  // A cell: its feed and its passes, in order.
  function makeCell(name) {
    const m = /^(blit\+)?(ext|tex)-(s|l)(\d)(-fw)?$/.exec(name);
    if (m) {
      const pre = !!m[1];
      const feed = m[2];
      if (feed === "ext" && pre)
        throw new Error(name + ": blit then external makes no sense");
      const passes = [];
      if (pre) passes.push(blitPass());
      passes.push(
        tapsPass(feed, Number(m[4]), m[3], !!m[5], pre ? views.blit : inView),
      );
      return { name, feed: pre || feed === "ext" ? "ext" : "tex", passes };
    }
    if (name === "blit") return { name, feed: "ext", passes: [blitPass()] };
    const w = /^(blit\+)?(ext-)?mwsr(?::(.*))?$/.exec(name);
    if (w) {
      const pre = !!w[1];
      const feed = w[2] ? "ext" : "tex";
      if (feed === "ext" && pre)
        throw new Error(name + ": blit then external makes no sense");
      const opts = Object.fromEntries(
        (w[3] || "")
          .split(";")
          .filter(Boolean)
          .map((kv) => kv.split("=")),
      );
      const passes = pre ? [blitPass()] : [];
      passes.push(mwsrPass(name, feed, opts, pre ? views.blit : inView));
      return { name, feed: pre || feed === "ext" ? "ext" : "tex", passes };
    }
    const k = /^(blit\+)?(sgsr-repo|sgsr-src|nis|easu|rcas|fsr1)$/.exec(name);
    if (k) {
      const pre = !!k[1];
      const srcView = pre ? views.blit : inView;
      const passes = pre ? [blitPass()] : [];
      if (k[2] === "rcas") passes.push(rcasFrom(views.mid));
      else if (k[2] === "fsr1")
        passes.push(easuToInterm(srcView), rcasFrom(views.interm));
      else passes.push(kernelPass(k[2], srcView));
      return { name, feed: pre ? "ext" : "tex", passes };
    }
    if (name.startsWith("chain-"))
      return { name, feed: "chain", algo: name.slice(6) };
    throw new Error("cell " + name + "?");
  }

  // Timestamps: a query set wide enough for a batch of the longest chain,
  // resolved once per batch into a mappable buffer.
  const maxPasses = 3;
  const qCount = 2 * maxPasses * batch;
  let querySet = null;
  let resolveBuf = null;
  let readBuf = null;
  if (hasTs) {
    querySet = device.createQuerySet({ type: "timestamp", count: qCount });
    const bytes = Math.ceil((qCount * 8) / 256) * 256;
    resolveBuf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    readBuf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }
  let frameCursor = 0;
  const nextFrame = () => frames[frameCursor++ % frames.length];

  // One batch of `iters` iterations of a cell in one command buffer; the
  // GPU time of each pass of each iteration, and the wall time submit → done.
  async function runBatch(cell, iters, stamp) {
    const enc = device.createCommandEncoder();
    let q = 0;
    for (let i = 0; i < iters; i++) {
      let ext = null;
      if (cell.feed === "ext") {
        if (!frames.length)
          throw new Error(
            cell.name + ": no VideoFrame (codec=none, or the loop failed)",
          );
        ext = device.importExternalTexture({
          source: nextFrame(),
          colorSpace: "srgb",
        });
      }
      for (const ps of cell.passes) {
        const desc = {
          colorAttachments: [
            {
              view: views[ps.target],
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        };
        if (stamp) {
          desc.timestampWrites = {
            querySet,
            beginningOfPassWriteIndex: q,
            endOfPassWriteIndex: q + 1,
          };
          q += 2;
        }
        const pass = enc.beginRenderPass(desc);
        pass.setPipeline(ps.pipeline);
        pass.setBindGroup(0, ps.ext ? ps.ext(ext) : ps.group);
        pass.draw(3);
        pass.end();
      }
    }
    if (stamp && q) {
      enc.resolveQuerySet(querySet, 0, q, resolveBuf, 0);
      enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, q * 8);
    }
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    const wall = performance.now() - t0;
    let times = null;
    if (stamp && q) {
      await readBuf.mapAsync(GPUMapMode.READ, 0, q * 8);
      const a = new BigInt64Array(readBuf.getMappedRange(0, q * 8));
      times = [];
      for (let k = 0; k < q; k += 2) times.push(Number(a[k + 1] - a[k]) / 1e6);
      readBuf.unmap();
    }
    return { wall, times, passes: cell.passes.length, iters };
  }

  // The product's renderer, on an OffscreenCanvas, one draw per iteration;
  // its passes stamped by the hooks, its draw() awaited as the page does.
  // pace=tick spaces the draws by `period`, like the product's frames; flip=1
  // alternates the output size between the page's and the input's (1:1) from
  // one draw to the next: the renderer's 1:1 copy (P1) and the passage both
  // ways, with the pass count and the draw time of every iteration.
  const renderers = new Map();
  async function chainRenderer(algo) {
    if (renderers.has(algo)) return renderers.get(algo);
    const { WebGpuRenderer } = await import(RENDERER_URL);
    const canvas = new OffscreenCanvas(outW, outH);
    const r = await WebGpuRenderer.create(canvas, { algo, videoCodec: "h264" });
    r.setOutputSize(outW, outH);
    renderers.set(algo, r);
    return r;
  }
  async function runChain(cell, iters, stamp) {
    if (!frames.length) throw new Error(cell.name + ": no VideoFrame");
    const r = await chainRenderer(cell.algo);
    const times = [];
    const walls = [];
    const passSeq = [];
    let copies = 0;
    const start = performance.now();
    for (let i = 0; i < iters; i++) {
      if (flip) {
        if (i % 2) r.setOutputSize(inW, inH);
        else r.setOutputSize(outW, outH);
      }
      if (pace === "tick") {
        const due = start + i * period;
        const now = performance.now();
        if (due > now) await new Promise((res) => setTimeout(res, due - now));
      }
      HOOK.active = stamp;
      HOOK.q = 0;
      const f = nextFrame().clone();
      const t0 = performance.now();
      await r.draw(f);
      walls.push(performance.now() - t0);
      HOOK.active = false;
      if (r.passthrough === true) copies++;
      let np = 0;
      if (stamp && HOOK.q && HOOK.dev) {
        const q = HOOK.q;
        await HOOK.read.mapAsync(GPUMapMode.READ, 0, q * 8);
        const a = new BigInt64Array(HOOK.read.getMappedRange(0, q * 8));
        const ts = [];
        for (let k = 0; k < q; k += 2) ts.push(Number(a[k + 1] - a[k]) / 1e6);
        HOOK.read.unmap();
        np = q / 2;
        times.push(ts);
      }
      passSeq.push(np);
    }
    if (flip) r.setOutputSize(outW, outH);
    return {
      wall: walls.reduce((a, b) => a + b, 0),
      iterTimes: stamp && times.length ? times : null,
      passSeq,
      copies,
      iters,
      draws: walls,
    };
  }

  async function measure(cell, iters, stamp) {
    if (cell.feed === "chain") return runChain(cell, iters, stamp);
    if (pace === "tick") {
      // one iteration per period, each its own submission
      const times = [];
      let wall = 0;
      const start = performance.now();
      for (let i = 0; i < iters; i++) {
        const due = start + i * period;
        const now = performance.now();
        if (due > now) await new Promise((res) => setTimeout(res, due - now));
        const b = await runBatch(cell, 1, stamp);
        wall += b.wall;
        if (b.times) times.push(...b.times);
      }
      return {
        wall,
        times: stamp && times.length ? times : null,
        passes: cell.passes.length,
        iters,
      };
    }
    return runBatch(cell, iters, stamp);
  }

  const cells = cellNames.map((n) => {
    try {
      return makeCell(n);
    } catch (e) {
      errors.push(e.message);
      log("cell " + n + " skipped: " + e.message);
      return null;
    }
  });
  const results = new Map();
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const seq = r % 2 ? [...cells].reverse() : cells;
    for (const c of seq) if (c) order.push([c, r]);
  }
  const t0 = performance.now();
  for (const [cell, r] of order) {
    const e0 = errors.length;
    try {
      const iters =
        cell.feed === "chain"
          ? Math.max(8, Math.ceil((batch * batches) / 4))
          : batch;
      for (let w = 0; w < warm; w++)
        await measure(cell, cell.feed === "chain" ? 4 : iters, false);
      const totals = [];
      const perPass = [];
      let wallMs = 0;
      let n = 0;
      const nb = cell.feed === "chain" ? 1 : batches;
      for (let b = 0; b < nb; b++) {
        const m = await measure(cell, iters, hasTs);
        wallMs += m.wall;
        n += m.iters;
        if (m.iterTimes) {
          // the chain: every iteration its own passes, whose count may change
          // from one draw to the next (flip=1); totals also kept by that count
          for (const ts of m.iterTimes) {
            let s = 0;
            ts.forEach((t, k) => {
              s += t;
              (perPass[k] ||= []).push(t);
            });
            totals.push(s);
            ((cell.byPasses ||= {})[ts.length] ||= []).push(s);
          }
        } else if (m.times) {
          const np = m.passes;
          for (let i = 0; i + np <= m.times.length; i += np) {
            let s = 0;
            for (let k = 0; k < np; k++) {
              s += m.times[i + k];
              (perPass[k] ||= []).push(m.times[i + k]);
            }
            totals.push(s);
          }
        }
        if (m.draws) (cell.draws ||= []).push(...m.draws);
        if (m.passSeq) (cell.passSeq ||= []).push(...m.passSeq);
        if (m.copies !== undefined) cell.copies = (cell.copies || 0) + m.copies;
      }
      if (!results.has(cell.name)) results.set(cell.name, { cell, rounds: [] });
      results
        .get(cell.name)
        .rounds.push({ round: r, totals, perPass, wallPerIter: wallMs / n });
      const tot = stats(totals);
      log(
        `r${r} ${cell.name.padEnd(16)} ${tot ? "gpu p50 " + tot.p50.toFixed(3) + " p99 " + tot.p99.toFixed(3) : "no ts"}  wall/iter ${(wallMs / n).toFixed(3)} ms`,
      );
    } catch (e) {
      errors.push(String(e.message || e));
      log(cell.name + " failed: " + (e.message || e));
    }
    // a WebGPU validation error that surfaced during this cell: say which
    for (let i = e0; i < errors.length; i++)
      errors[i] = "[" + cell.name + "] " + errors[i];
  }
  const elapsed = performance.now() - t0;

  const out = [];
  for (const [name, r] of results) {
    const all = r.rounds.flatMap((x) => x.totals);
    const roundMed = r.rounds
      .map((x) => quant(x.totals, 0.5))
      .filter((x) => x !== null);
    const gpu = stats(all);
    const np = Math.max(...r.rounds.map((x) => x.perPass.length));
    const perPass = [];
    for (let k = 0; k < np; k++)
      perPass.push(
        quant(
          r.rounds.flatMap((x) => x.perPass[k] || []),
          0.5,
        ),
      );
    const wallPerIter = quant(
      r.rounds.map((x) => x.wallPerIter),
      0.5,
    );
    out.push({
      name,
      feed: r.cell.feed,
      passes: r.cell.feed === "chain" ? np : r.cell.passes.length,
      gpu,
      perPass,
      roundMedians: roundMed,
      disp:
        gpu && roundMed.length > 1
          ? ((Math.max(...roundMed) - Math.min(...roundMed)) / gpu.p50) * 100
          : null,
      wallPerIter,
      draw: r.cell.draws ? stats(r.cell.draws) : null,
      // the chain: how many draws had which pass count, how many were the
      // renderer's 1:1 copy, and the GPU total by pass count (flip=1)
      passSeq: r.cell.passSeq
        ? r.cell.passSeq.reduce((h, k) => ((h[k] = (h[k] || 0) + 1), h), {})
        : null,
      copies: r.cell.copies === undefined ? null : r.cell.copies,
      byPasses: r.cell.byPasses
        ? Object.fromEntries(
            Object.entries(r.cell.byPasses).map(([k, v]) => [k, stats(v)]),
          )
        : null,
    });
  }

  let shots = null;
  if (wantShots) {
    shots = {};
    for (const c of cells) {
      if (!c || c.feed === "chain") continue;
      try {
        await measure(c, 1, false);
        shots[c.name] = await crop(device, outTex, format, outW, outH);
      } catch (e) {
        errors.push("[shot " + c.name + "] " + e.message);
      }
    }
  }
  const dumped = [];
  for (const c of cells) {
    if (!c || c.feed === "chain" || !dumpList.includes(c.name)) continue;
    try {
      await measure(c, 1, false);
      const blob = await readPng(device, outTex, format, 0, 0, outW, outH);
      const name = (p.tag || "lab") + "-" + c.name.replace(/[^\w.+-]/g, "_");
      await postBlob("/__png?name=" + encodeURIComponent(name), blob);
      dumped.push(name);
    } catch (e) {
      errors.push("[dump " + c.name + "] " + e.message);
    }
  }
  if (dumped.length) log("dumped: " + dumped.join(" "));

  for (const f of frames) f.close();
  for (const r of renderers.values()) r.dispose();
  device.destroy();
  return {
    adapter: {
      name: adapterName,
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    },
    features,
    timestamps: hasTs,
    format,
    userAgent: navigator.userAgent,
    isolated: !!globalThis.crossOriginIsolated,
    params: {
      in: `${inW}x${inH}`,
      out: `${outW}x${outH}`,
      content,
      codec,
      pace,
      period,
      batch,
      batches,
      warm,
      rounds,
      sets,
      power: p.power || null,
      fallback: p.fallback === "1",
      flip,
    },
    frames: frameInfo,
    elapsedMs: elapsed,
    cells: out,
    shots,
    dumped,
    errors,
  };
}

async function postBlob(url, blob) {
  const r = await fetch(url, { method: "POST", body: blob });
  if (!r.ok) throw new Error("POST " + url + ": " + r.status);
}

// A centre crop of the output texture (512×288), as a PNG data URL.
async function crop(device, tex, format, w, h) {
  const cw = Math.min(512, w);
  const ch = Math.min(288, h);
  const x = Math.floor((w - cw) / 2);
  const y = Math.floor((h - ch) / 2);
  const blob = await readPng(device, tex, format, x, y, cw, ch);
  return await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
}

// A region of a texture read back, as a PNG blob.
async function readPng(device, tex, format, x, y, cw, ch) {
  const bpr = Math.ceil((cw * 4) / 256) * 256;
  const buf = device.createBuffer({
    size: bpr * ch,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: tex, origin: { x, y } },
    { buffer: buf, bytesPerRow: bpr },
    { width: cw, height: ch },
  );
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const a = new Uint8Array(buf.getMappedRange());
  const img = new ImageData(cw, ch);
  const bgra = format === "bgra8unorm";
  for (let r = 0; r < ch; r++)
    for (let c = 0; c < cw; c++) {
      const s = r * bpr + c * 4;
      const d = (r * cw + c) * 4;
      img.data[d] = bgra ? a[s + 2] : a[s];
      img.data[d + 1] = a[s + 1];
      img.data[d + 2] = bgra ? a[s] : a[s + 2];
      img.data[d + 3] = 255;
    }
  buf.unmap();
  buf.destroy();
  const cv = new OffscreenCanvas(cw, ch);
  cv.getContext("2d").putImageData(img, 0, 0);
  return await cv.convertToBlob({ type: "image/png" });
}

// ── hooks for the product's renderer ───────────────────────────────────────
// Nothing in the product changes: its adapter request takes the lab's options,
// its device gets timestamp-query when the adapter has it, and while a chain
// cell draws, every render pass it begins is stamped and every command buffer
// it finishes resolves the stamps into a buffer the lab maps afterwards.
const HOOK = {
  active: false,
  q: 0,
  dev: null,
  qs: null,
  resolve: null,
  read: null,
  count: 8,
};
let hooked = false;
function installHooks(adapterOpts) {
  if (hooked) return;
  hooked = true;
  const origReq = GPU.prototype.requestAdapter;
  GPU.prototype.requestAdapter = function (opts) {
    return origReq.call(this, { ...(opts || {}), ...adapterOpts });
  };
  const origDev = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (desc) {
    const d = { ...(desc || {}) };
    const f = new Set(d.requiredFeatures || []);
    if (this.features.has("timestamp-query")) f.add("timestamp-query");
    d.requiredFeatures = [...f];
    return origDev.call(this, d);
  };
  const origEnc = GPUDevice.prototype.createCommandEncoder;
  GPUDevice.prototype.createCommandEncoder = function (d) {
    const e = origEnc.call(this, d);
    e.__dev = this;
    return e;
  };
  const ensure = (dev) => {
    if (HOOK.dev === dev) return true;
    if (!dev.features.has("timestamp-query")) return false;
    HOOK.dev = dev;
    HOOK.qs = dev.createQuerySet({ type: "timestamp", count: HOOK.count });
    HOOK.resolve = dev.createBuffer({
      size: 256,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    HOOK.read = dev.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    return true;
  };
  const origPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
    if (
      HOOK.active &&
      !desc.timestampWrites &&
      this.__dev &&
      ensure(this.__dev) &&
      HOOK.q + 2 <= HOOK.count
    ) {
      desc = {
        ...desc,
        timestampWrites: {
          querySet: HOOK.qs,
          beginningOfPassWriteIndex: HOOK.q,
          endOfPassWriteIndex: HOOK.q + 1,
        },
      };
      HOOK.q += 2;
      this.__stamped = true;
    }
    return origPass.call(this, desc);
  };
  const origFinish = GPUCommandEncoder.prototype.finish;
  GPUCommandEncoder.prototype.finish = function (d) {
    if (this.__stamped && HOOK.q) {
      this.resolveQuerySet(HOOK.qs, 0, HOOK.q, HOOK.resolve, 0);
      this.copyBufferToBuffer(HOOK.resolve, 0, HOOK.read, 0, HOOK.q * 8);
      this.__stamped = false;
    }
    return origFinish.call(this, d);
  };
}
