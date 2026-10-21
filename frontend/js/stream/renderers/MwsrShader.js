/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * MwsrShader — the texts of `mwsr`, MoonlightWeb's own upscaler
 * (docs/design/upscaler-mwsr.md, §3): one WGSL source specialised by
 * `override` constants, the input feed substituted in its preamble. The GLSL
 * ES 3.00 twin (plan §3.6, phase P4) will be generated from the same table of
 * constants, so that the two texts cannot drift apart.
 *
 * The kernel, per output pixel (plan §3.2):
 *   1. one bilinear sample C at the pixel's position in the input, its luma;
 *   2. the vote: the screen derivatives of that luma, scaled to luma per input
 *      texel, decide per 2×2 quad whether the pixel sits on an edge; a flat
 *      quad returns C — one sample, a dozen operations;
 *   3. on an edge, four more bilinear samples, laid along and across the edge
 *      the derivatives measure (ORIENT 1) or on the axes (ORIENT 0): the
 *      along pair smooths the staircase, the across pair sharpens the ramp;
 *   4. a coherence term (a step or a ridge across, against all the variation
 *      around) doses both, so that grain, texture and compression blocks are
 *      left alone; the whole fades to C near 1:1;
 *   5. the result is bounded by the min and max of the five samples.
 *
 * Written from scratch (plan §10.2). Ideas taken, and credited: bilinear taps
 * instead of gathers (Atyuwen's mobile EASU, Jimenez, MJP); the early out on
 * an edge vote (SGSR1, NEDI); the local min/max bound against ringing (EASU,
 * SGSR1); sharpening held by the local range (CAS, RCAS). The vote by screen
 * derivatives and the taps laid along the measured edge are this project's.
 * No line, polynomial or constant of FSR1, SGSR1, NIS or the gist is
 * reproduced; the constants come from the laboratory
 * (scripts/bench/scaler-lab/journal.md), the test file checks the forbidden
 * ones never creep in.
 */

/**
 * The pipeline-overridable constants, with their type and the default the
 * WGSL text declares. A renderer sets them at pipeline creation
 * (`fragment.constants`), the laboratory per cell (`mwsr:orient=0;...`).
 */
export const MWSR_OVERRIDE_SPEC = Object.freeze({
    /** 1: taps along/across the edge the derivatives measure; 0: axis cross. */
    ORIENT: ['u32', 1],
    /** 1: branch after the vote; 0: no branch, same pixels (a timing A/B). */
    EARLY_OUT: ['u32', 1],
    /** 1: paint the vote (white = edge quad, black = flat) instead of the picture. */
    SHOW: ['u32', 0],
    /** Weight of each tap along the edge, at full coherence and strength. */
    W_ALONG: ['f32', 0.35],
    /** Weight of each tap across the edge, negated and × sharpness. */
    W_ACROSS: ['f32', 0.2],
    /** Distance of the along taps, input texels. */
    R_ALONG: ['f32', 1.0],
    /** Distance of the across taps, input texels. */
    R_ACROSS: ['f32', 1.0],
    /** The scale (output / input) from which the kernel is at full strength; 0 at 1:1. */
    S_FULL: ['f32', 1.5],
    /** The most negative weight of an across tap: the blend's divisor stays >= 1 + 2 W_MIN. */
    W_MIN: ['f32', -0.24],
});

/** The defaults alone, name → value. */
export const MWSR_OVERRIDES = Object.freeze(
    Object.fromEntries(Object.entries(MWSR_OVERRIDE_SPEC).map(([k, [, v]]) => [k, v])),
);

/** Constants shared by the WGSL text and, later, its GLSL twin. */
export const MWSR_CONSTANTS = Object.freeze({
    /** Luma weights: Rec. 709 rounded to powers of two, two multiply-adds. */
    LUMA: [0.25, 0.625, 0.125],
    /** Guards the divisions by a variation of luma. */
    EPS: 1e-5,
});

/** The per-draw values of the uniform block: the vote threshold (luma per
 *  input texel) and the sharpness (× W_ACROSS). */
export const MWSR_UNIFORMS = Object.freeze({ tau: 0.05, sharp: 1.0 });

/** Number of f32 in the uniform block: texel.xy, scale.xy, tau, sharp, pad.xy. */
export const MWSR_UNIFORM_FLOATS = 8;

/**
 * The uniform block for an input of inW×inH drawn at outW×outH.
 * @param {number} inW
 * @param {number} inH
 * @param {number} outW
 * @param {number} outH
 * @param {{tau?: number, sharp?: number}} [u]
 * @returns {Float32Array}
 */
export function mwsrUniforms(inW, inH, outW, outH, u = {}) {
    const tau = u.tau ?? MWSR_UNIFORMS.tau;
    const sharp = u.sharp ?? MWSR_UNIFORMS.sharp;
    return new Float32Array([1 / inW, 1 / inH, outW / inW, outH / inH, tau, sharp, 0, 0]);
}

function wgslNumber(type, v) {
    if (type === 'u32') return `${v >>> 0}u`;
    const s = String(v);
    return /[.e]/.test(s) ? s : s + '.0';
}

const FEEDS = {
    tex: {
        decl: '@group(0) @binding(1) var tex : texture_2d<f32>;',
        sample: `fn S(uv : vec2f) -> vec3f {
    return textureSampleLevel(tex, samp, uv, 0.0).rgb;
}`,
    },
    ext: {
        decl: '@group(0) @binding(1) var tex : texture_external;',
        sample: `fn S(uv : vec2f) -> vec3f {
    return textureSampleBaseClampToEdge(tex, samp, uv).rgb;
}`,
    },
};

/**
 * The WGSL text of the kernel: a full-screen triangle (`vs`) and the fragment
 * stage (`fs`); bindings 0 sampler (linear, clamp to edge), 1 the feed, 2 the
 * uniform block of mwsrUniforms(). Explicit LOD and clamp-to-edge sampling
 * only, so the samples may sit in the non-uniform branch; the derivatives are
 * taken before it, in uniform control flow, as WGSL requires.
 * @param {{feed?: 'tex'|'ext'}} [opts] 'tex' reads a texture_2d<f32> (HDR
 *   paths, laboratory); 'ext' the decoded frame's texture_external (SDR, no
 *   pass 0).
 * @returns {string}
 */
export function mwsrWgsl({ feed = 'tex' } = {}) {
    const f = FEEDS[feed];
    if (!f) throw new Error('mwsr: feed ' + feed + '?');
    const overrides = Object.entries(MWSR_OVERRIDE_SPEC)
        .map(([k, [t, v]]) => `override ${k} : ${t} = ${wgslNumber(t, v)};`)
        .join('\n');
    const [lr, lg, lb] = MWSR_CONSTANTS.LUMA;
    return `struct VSOut {
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

struct U {
    texel : vec2f,
    scale : vec2f,
    tau : f32,
    sharp : f32,
    pad : vec2f,
};

@group(0) @binding(0) var samp : sampler;
${f.decl}
@group(0) @binding(2) var<uniform> u : U;

${f.sample}

${overrides}

const LUMA : vec3f = vec3f(${wgslNumber('f32', lr)}, ${wgslNumber('f32', lg)}, ${wgslNumber('f32', lb)});
const EPS : f32 = ${wgslNumber('f32', MWSR_CONSTANTS.EPS)};

fn luma(c : vec3f) -> f32 {
    return dot(c, LUMA);
}

// Five samples blended in the frame of an edge: the centre, a pair along it
// (weight wT each, smoothing) and a pair across it (weight wX each, negative:
// sharpening), the result bounded by the five.
fn blend(C : vec3f, T1 : vec3f, T2 : vec3f, X1 : vec3f, X2 : vec3f, wT : f32, wX : f32) -> vec3f {
    let R = (C + wT * (T1 + T2) + wX * (X1 + X2)) / (1.0 + 2.0 * (wT + wX));
    let lo = min(min(C, T1), min(T2, min(X1, X2)));
    let hi = max(max(C, T1), max(T2, max(X1, X2)));
    return clamp(R, lo, hi);
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
    let uv = in.uv;
    let C = S(uv);
    let lC = luma(C);
    // The vote: the screen derivatives of the bilinear luma, scaled to luma
    // per input texel; coarse, so the whole quad takes the same branch.
    let gx = dpdxCoarse(lC) * u.scale.x;
    let gy = dpdyCoarse(lC) * u.scale.y;
    let flat = abs(gx) + abs(gy) < u.tau;
    if (SHOW == 1u) {
        return vec4f(vec3f(select(1.0, 0.0, flat)), 1.0);
    }
    if (EARLY_OUT == 1u && flat) {
        return vec4f(C, 1.0);
    }
    // Strength: none at 1:1 (the renderer copies the frame there), full from
    // S_FULL on; none on a flat quad when there is no branch.
    let smin = min(u.scale.x, u.scale.y);
    let strength = clamp((smin - 1.0) / (S_FULL - 1.0), 0.0, 1.0) * select(1.0, 0.0, flat);
    var R : vec3f;
    if (ORIENT == 1u) {
        // The taps along and across the edge the derivatives measure.
        let n = vec2f(gx, gy) * inverseSqrt(max(gx * gx + gy * gy, 1e-12));
        let dt = vec2f(-n.y, n.x) * u.texel * R_ALONG;
        let dn = n * u.texel * R_ACROSS;
        let T1 = S(uv - dt);
        let T2 = S(uv + dt);
        let X1 = S(uv - dn);
        let X2 = S(uv + dn);
        let lT1 = luma(T1);
        let lT2 = luma(T2);
        let lX1 = luma(X1);
        let lX2 = luma(X2);
        // Coherence: a step (|X2 - X1|) or a ridge (|X1 + X2 - 2C|) across,
        // against all the variation around: 1 on a clean edge or line, near
        // 0 on texture, grain and compression blocks.
        let step = abs(lX2 - lX1);
        let ridge = abs(lX1 + lX2 - 2.0 * lC);
        let variation = abs(lX2 - lC) + abs(lC - lX1) + abs(lT2 - lC) + abs(lC - lT1) + EPS;
        let a = max(step, ridge) / variation * strength;
        let wT = W_ALONG * a;
        let wX = max(-W_ACROSS * u.sharp * a, W_MIN);
        R = blend(C, T1, T2, X1, X2, wT, wX);
    } else {
        // The axis cross; its frame comes from the taps, and each pair blends
        // its along and across weights by the gradient's share along x.
        let A = S(uv - vec2f(0.0, u.texel.y) * R_ALONG);
        let B = S(uv - vec2f(u.texel.x, 0.0) * R_ALONG);
        let D = S(uv + vec2f(u.texel.x, 0.0) * R_ALONG);
        let E = S(uv + vec2f(0.0, u.texel.y) * R_ALONG);
        let lA = luma(A);
        let lB = luma(B);
        let lD = luma(D);
        let lE = luma(E);
        let hx = lD - lB;
        let hy = lE - lA;
        let q = hx * hx / (hx * hx + hy * hy + EPS);
        let step = abs(hx) + abs(hy);
        let ridge = max(abs(lB + lD - 2.0 * lC), abs(lA + lE - 2.0 * lC));
        let variation = abs(lD - lC) + abs(lC - lB) + abs(lE - lC) + abs(lC - lA) + EPS;
        let a = max(step, ridge) / variation * strength;
        let wT = W_ALONG * a;
        let wX = max(-W_ACROSS * u.sharp * a, W_MIN);
        R = blend(C, B, D, A, E, mix(wT, wX, q), mix(wT, wX, 1.0 - q));
    }
    return vec4f(R, 1.0);
}
`;
}
