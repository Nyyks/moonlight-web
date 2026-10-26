// The HDR A/B for the eye (journal J48): mwsr's upscale through the product's
// WebGpuRenderer on its HDR `linear` path (the float canvas, toneMapping
// 'extended'), with today's DERING 2 on one side and DERING 1 on the other,
// drawn by lot behind the neutral labels A and B; the key on a button. The
// pictures are hdr_check.py's (PQ, BT.2020, I420P10, 1000-nit text, the
// 0 A.D. capture, the ramp with its 1-px stripes), served from its output
// directory under /__dir/ (scaler_lab.py --serve --dir bench-out/scaler-lab/hdr).
// Two renderers, two canvases at one canvas pixel per device pixel; the panes
// scroll together, or one pane shows at a time and Space flips it.
import { WebGpuRenderer } from "/frontend/js/stream/renderers/WebGpuRenderer.js";

const CASES = [
  { name: "up720-text", label: "Texte 1000 nits, 720p → 1440p", w: 1280, h: 720, ow: 2560, oh: 1440 },
  { name: "up720-game", label: "Jeu (0 A.D.), 720p → 1440p", w: 1280, h: 720, ow: 2560, oh: 1440 },
  { name: "up1080-game", label: "Jeu (0 A.D.), 1080p → 1440p", w: 1920, h: 1080, ow: 2560, oh: 1440 },
  { name: "up1080-ramp", label: "Traits fins (rampe, rayures 1 px), 1080p → 1440p", w: 1920, h: 1080, ow: 2560, oh: 1440 },
  { name: "up720-ramp", label: "Traits fins (rampe, rayures 1 px), 720p → 1440p", w: 1280, h: 720, ow: 2560, oh: 1440 },
];
const SETS = [
  { key: "DERING 2 (le défaut actuel)", overrides: {} },
  { key: "DERING 1 (proposé pour le HDR)", overrides: { DERING: 1 } },
];
// the lot: which set is A, drawn once per load (a reload draws again)
const swap = Math.random() < 0.5;
const sides = swap ? [SETS[1], SETS[0]] : [SETS[0], SETS[1]];

const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);
let renderers = [null, null];
let ts = 1;

async function makeRenderers() {
  const out = [];
  for (const [i, id] of ["cvA", "cvB"].entries()) {
    const r = await WebGpuRenderer.create($(id), {
      algo: "mwsr",
      hdr: true,
      hdrLinear: true,
      videoCodec: "hevc",
    });
    r.setMwsrOverrides(sides[i].overrides);
    out.push(r);
  }
  return out;
}

async function show(c) {
  status("chargement de " + c.name + "…");
  const res = await fetch("/__dir/hdr-" + c.name + ".yuv");
  if (!res.ok) throw new Error("hdr-" + c.name + ".yuv: HTTP " + res.status + " (lancer hdr_check.py --ablate une fois)");
  const planes = new Uint8Array(await res.arrayBuffer());
  for (const [i, r] of renderers.entries()) {
    r.setOutputSize(c.ow, c.oh);
    const frame = new VideoFrame(planes, {
      format: "I420P10",
      codedWidth: c.w,
      codedHeight: c.h,
      timestamp: ts++ * 16667,
      colorSpace: { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false },
    });
    await r.draw(frame);
    const cv = [$("cvA"), $("cvB")][i];
    // one canvas pixel per device pixel
    cv.style.width = cv.width / devicePixelRatio + "px";
    cv.style.height = cv.height / devicePixelRatio + "px";
  }
  const r = renderers[0];
  const hdrScreen = matchMedia("(dynamic-range: high)").matches;
  status(
    `${c.w}×${c.h} → ${c.ow}×${c.oh} | écran HDR : ${hdrScreen ? "oui" : "NON (activer le HDR de Windows)"} | ` +
      `canvas : ${r._format}${r._hdrLinear ? ", HDR linéaire" : ", pas de HDR"} | chemin : ${r.lastDraw ? r.lastDraw.path : "?"}`,
  );
}

function syncScroll() {
  const a = $("paneA");
  const b = $("paneB");
  let busy = false;
  const link = (from, to) =>
    from.addEventListener("scroll", () => {
      if (busy) return;
      busy = true;
      to.scrollLeft = from.scrollLeft;
      to.scrollTop = from.scrollTop;
      busy = false;
    });
  link(a, b);
  link(b, a);
}

function setView(v) {
  document.body.classList.toggle("flip", v === "flip");
  $("paneA").classList.remove("hidden");
  $("paneB").classList.toggle("hidden", v === "flip");
}

async function main() {
  if (!navigator.gpu) throw new Error("pas de WebGPU dans ce navigateur");
  for (const c of CASES) $("case").add(new Option(c.label, c.name));
  $("case").addEventListener("change", () => show(CASES.find((c) => c.name === $("case").value)).catch(fail));
  $("view").addEventListener("change", () => setView($("view").value));
  $("reveal").addEventListener("click", () => {
    $("key").textContent = `A = ${sides[0].key} · B = ${sides[1].key}`;
  });
  addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !document.body.classList.contains("flip")) return;
    e.preventDefault();
    const aHidden = $("paneA").classList.toggle("hidden");
    $("paneB").classList.toggle("hidden", !aHidden);
    // the same place in the picture on both
    const [from, to] = aHidden ? [$("paneA"), $("paneB")] : [$("paneB"), $("paneA")];
    to.scrollLeft = from.scrollLeft;
    to.scrollTop = from.scrollTop;
  });
  syncScroll();
  renderers = await makeRenderers();
  await show(CASES[0]);
  window.__ready = true;
}

function fail(e) {
  status("erreur : " + ((e && e.message) || e));
  window.__error = String((e && e.stack) || e);
}

main().catch(fail);
