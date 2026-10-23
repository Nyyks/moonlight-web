import { describe, it, expect } from 'vitest';
import {
    MWSR_CONSTANTS,
    MWSR_DOWN_TAPS,
    MWSR_DOWN_TAPS_SRGB,
    MWSR_OVERRIDES,
    MWSR_OVERRIDE_SPEC,
    MWSR_UNIFORM_FLOATS,
    mwsrGlsl,
    mwsrRegime,
    mwsrRegimeKey,
    mwsrRegimes,
    mwsrUniforms,
    mwsrWgsl,
} from '../js/stream/renderers/MwsrShader.js';

describe('the mwsr shader text', () => {
    const tex = mwsrWgsl({ feed: 'tex' });
    const ext = mwsrWgsl({ feed: 'ext' });
    const down = mwsrWgsl({ mode: 'down' });
    const glsl = mwsrGlsl();
    const glslDown = mwsrGlsl({ mode: 'down' });
    const kernel = (s) => s.slice(s.indexOf('override '));

    it('reads either feed with the same kernel', () => {
        expect(tex).toContain('var tex : texture_2d<f32>;');
        expect(tex).toContain('textureSampleLevel(tex, samp, uv, 0.0)');
        expect(ext).toContain('var tex : texture_external;');
        expect(ext).toContain('textureSampleBaseClampToEdge(tex, samp, uv)');
        expect(kernel(tex)).toBe(kernel(ext));
        expect(mwsrWgsl()).toBe(tex);
        expect(() => mwsrWgsl({ feed: 'yuv' })).toThrow(/feed/);
        expect(() => mwsrWgsl({ mode: 'side' })).toThrow(/mode/);
    });

    it('declares every override with its default, in both modes', () => {
        for (const text of [tex, down]) {
            for (const [name, [type, value]] of Object.entries(MWSR_OVERRIDE_SPEC)) {
                const lit =
                    type === 'u32' ? `${value}u` : Number.isInteger(value) ? `${value}.0` : `${value}`;
                expect(text).toContain(`override ${name} : ${type} = ${lit};`);
                expect(MWSR_OVERRIDES[name]).toBe(value);
            }
            expect(text).toContain('const LUMA : vec3f = vec3f(0.25, 0.625, 0.125);');
        }
        expect(MWSR_CONSTANTS.LUMA.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    });

    it('takes its derivatives before the branch, and samples with an explicit level only', () => {
        const fs = tex.slice(tex.indexOf('@fragment'));
        const vote = fs.indexOf('dpdxCoarse');
        const branch = fs.indexOf('if (flat) {');
        expect(vote).toBeGreaterThan(0);
        expect(branch).toBeGreaterThan(vote);
        expect(fs.slice(branch)).not.toMatch(/dpd[xy]|fwidth/);
        for (const text of [tex, down]) expect(text).not.toMatch(/textureSample\(/);
    });

    it('votes from the luma, or from the steepest channel when CHROMA444 is set', () => {
        expect(tex).toContain('let dx = dpdxCoarse(C) * u.scale.x;');
        expect(tex).toContain('let c444 = CHROMA444 == 1u;');
        expect(tex).toContain('let gx = select(dot(dx, LUMA), select(select(dx.r, dx.g, rg), dx.b, b), c444);');
        expect(tex).toContain('coherence(Ch.r, T1.r, T2.r, X1.r, X2.r)');
        expect(tex).not.toContain('LUMA_SHARP');
    });

    it('has a half-precision variant for the edge path of the up mode only', () => {
        const half = mwsrWgsl({ feed: 'ext', half: true });
        expect(half.startsWith('enable f16;')).toBe(true);
        expect(half).toContain('alias hf = f16;');
        expect(half).toContain('alias h3 = vec3<f16>;');
        expect(tex.startsWith('enable')).toBe(false);
        expect(tex).toContain('alias hf = f32;');
        // the vote and the frame stay in f32 whatever the variant
        for (const text of [tex, half]) {
            expect(text).toContain('let dx = dpdxCoarse(C) * u.scale.x;');
            expect(text).toContain('let n = vec2f(gx, gy) * inverseSqrt(');
            expect(text).toContain('var R = vec3f(blend(Ch, T1, T2, X1, X2, wT, wX));');
        }
        expect(kernel(half)).toBe(kernel(mwsrWgsl({ feed: 'tex', half: true })));
        // the reduction ignores `half`: its sums stay in f32
        expect(mwsrWgsl({ mode: 'down', half: true })).toBe(down);
    });

    it('reduces with an unrolled grid of 4, 9 or 16 samples over the footprint, or one sample', () => {
        for (const taps of [4, 9, 16]) {
            const text = mwsrWgsl({ mode: 'down', taps });
            expect(text.match(/acc \+= dec\(S\(uv \+ vec2f\(/g)).toHaveLength(taps);
            expect(text).toContain(`enc(acc * ${1 / taps})`);
            expect(text).toContain('let span = u.texel / u.scale * R_DOWN;');
            expect(text).toContain('if (LINEAR_LIGHT == 2u) {');
            expect(text).toContain('fn srgbToLin(');
            expect(text).not.toMatch(/dpd[xy]|fwidth|blend\(/);
        }
        expect(down).toBe(mwsrWgsl({ mode: 'down', taps: 4 }));
        expect(down).toContain('acc += dec(S(uv + vec2f(-0.25, -0.25) * span));');
        expect(down).toContain('acc += dec(S(uv + vec2f(0.25, 0.25) * span));');
        for (const taps of [0, 2, 5, 8, 25]) expect(() => mwsrWgsl({ mode: 'down', taps })).toThrow(/taps/);
        // one sample through sRGB views: the hardware's bilinear in linear light
        const one = mwsrWgsl({ mode: 'down', taps: 1 });
        expect(one.match(/acc \+= dec\(S\(uv \+ vec2f\(/g)).toHaveLength(1);
        expect(one).toContain('acc += dec(S(uv + vec2f(0.0, 0.0) * span));');
        expect(one).toContain('enc(acc * 1.0)');
    });

    it('picks the mode, the grid, its span and its light by the scale and the views', () => {
        const soft = { linearLight: 1 };
        expect(mwsrRegime(1920, 1080, 1920, 1080)).toEqual({ mode: 'copy', taps: 0, rDown: 0, linearLight: 0 });
        expect(mwsrRegime(1280, 720, 2560, 1440).mode).toBe('up');
        expect(mwsrRegime(1920, 1080, 2560, 1440).mode).toBe('up');
        expect(mwsrRegime(2560, 1440, 1920, 1080)).toEqual({ mode: 'down', taps: 4, rDown: 1, ...soft });
        expect(mwsrRegime(2560, 1440, 1280, 720)).toEqual({ mode: 'down', taps: 4, rDown: 1, ...soft });
        expect(mwsrRegime(3840, 2160, 1280, 720)).toEqual({ mode: 'down', taps: 9, rDown: 1.25, ...soft });
        expect(mwsrRegime(3840, 2160, 640, 360)).toEqual({ mode: 'down', taps: 16, rDown: 1.25, ...soft });
        // through sRGB views the hardware makes the light: one sample down to ×0.5
        const srgb = { srgb: true };
        const hw = { linearLight: 0 };
        expect(mwsrRegime(1920, 1080, 1920, 1080, srgb).mode).toBe('copy');
        expect(mwsrRegime(1280, 720, 2560, 1440, srgb).mode).toBe('up');
        expect(mwsrRegime(2560, 1440, 1920, 1080, srgb)).toEqual({ mode: 'down', taps: 1, rDown: 1, ...hw });
        expect(mwsrRegime(2560, 1440, 1280, 720, srgb)).toEqual({ mode: 'down', taps: 1, rDown: 1, ...hw });
        expect(mwsrRegime(3840, 2160, 1280, 720, srgb)).toEqual({ mode: 'down', taps: 9, rDown: 1.25, ...hw });
        expect(mwsrRegime(3840, 2160, 640, 360, srgb)).toEqual({ mode: 'down', taps: 16, rDown: 1.25, ...hw });
        // the smaller axis decides, and a 1.001 × 0.999 box is a reduction
        expect(mwsrRegime(1000, 1000, 1001, 999).mode).toBe('down');
        expect(mwsrRegime(1000, 1000, 1001, 1000).mode).toBe('up');
        for (const table of [MWSR_DOWN_TAPS, MWSR_DOWN_TAPS_SRGB])
            for (const [, taps] of table) expect(() => mwsrWgsl({ mode: 'down', taps })).not.toThrow();
        expect(MWSR_OVERRIDES.LINEAR_LIGHT).toBe(1);
    });

    it('lists every regime a renderer builds its pipelines for', () => {
        for (const srgb of [false, true]) {
            const regs = mwsrRegimes({ srgb });
            const table = srgb ? MWSR_DOWN_TAPS_SRGB : MWSR_DOWN_TAPS;
            expect(regs[0]).toEqual({ mode: 'up', taps: 5, rDown: 0, linearLight: 0 });
            expect(regs.slice(1)).toEqual(
                table.map(([, taps, rDown]) => ({ mode: 'down', taps, rDown, linearLight: srgb ? 0 : 1 })),
            );
            // every answer of mwsrRegime() at scale is one of them
            for (const s of [0.1, 0.2, 0.3, 0.49, 0.5, 0.75, 0.99, 1.33, 2, 3])
                expect(regs).toContainEqual(mwsrRegime(100, 100, Math.round(100 * s), Math.round(100 * s), { srgb }));
            expect(regs).not.toContainEqual(mwsrRegime(100, 100, 100, 100, { srgb }));
        }
        expect(mwsrRegimes()).toEqual(mwsrRegimes({ srgb: false }));
    });

    it('uses no gather, no discard, no loop, no dynamic indexing (plan §3.4)', () => {
        for (const text of [tex, down, mwsrWgsl({ mode: 'down', taps: 16 }), glsl, glslDown])
            expect(text).not.toMatch(/textureGather|discard|\bfor\s*\(|\bloop\b|\bwhile\b|\[\s*i\s*\]/);
    });

    it('has a GLSL ES 3.00 twin written from the same tables (plan §3.6)', () => {
        expect(glsl.startsWith('#version 300 es\n')).toBe(true);
        expect(glslDown.startsWith('#version 300 es\n')).toBe(true);
        for (const text of [glsl, glslDown]) {
            for (const [name, [type, value]] of Object.entries(MWSR_OVERRIDE_SPEC)) {
                const lit =
                    type === 'u32' ? `${value}u` : Number.isInteger(value) ? `${value}.0` : `${value}`;
                expect(text).toContain(`const ${type === 'u32' ? 'uint' : 'float'} ${name} = ${lit};`);
            }
            expect(text).toContain('const vec3 LUMA = vec3(0.25, 0.625, 0.125);');
            expect(text).toContain('uniform vec4 uTexelScale;');
            expect(text).toContain('uniform vec4 uTauSharp;');
            expect(text).not.toMatch(/\btexture\(/);
        }
        // the overrides are baked into the text, by name
        const c444 = mwsrGlsl({ overrides: { CHROMA444: 1, W_ALONG: 0.2 } });
        expect(c444).toContain('const uint CHROMA444 = 1u;');
        expect(c444).toContain('const float W_ALONG = 0.2;');
        expect(c444).toContain('const float W_ACROSS = 0.3;');
        expect(() => mwsrGlsl({ overrides: { NOPE: 1 } })).toThrow(/override/);
        expect(() => mwsrGlsl({ mode: 'side' })).toThrow(/mode/);
        // the same kernel: derivatives first, explicit level and texel fetches, the bound
        const main = glsl.slice(glsl.indexOf('void main()'));
        expect(main.indexOf('dFdx(C)')).toBeGreaterThan(0);
        // GL's window y runs up: the WGSL dpdy is -dFdy here
        expect(main).toContain('vec3 dy = -dFdy(C) * uTexelScale.w;');
        expect(tex).toContain('let dy = dpdyCoarse(C) * u.scale.y;');
        expect(main.indexOf('dFdx(C)')).toBeLessThan(main.indexOf('if (isFlat)'));
        expect(main.slice(main.indexOf('if (isFlat)'))).not.toMatch(/dFd[xy]/);
        expect(glsl).toContain('textureLod(uTex, uv, 0.0)');
        expect(glsl).toContain('texelFetch(uTex, c, 0)');
        expect(glsl).toContain('mediump vec3 T1 = S(uv - dt);');
        for (const line of ['let strength = clamp((smin - 1.0) / (S_FULL - 1.0), 0.0, 1.0);'])
            expect(tex).toContain(line);
        expect(glsl).toContain('float strength = clamp((smin - 1.0) / (S_FULL - 1.0), 0.0, 1.0);');
        // the same grids, from the same offsets
        const offs = (t) => [...t.matchAll(/vec2f?\(([-\d.]+), ([-\d.]+)\) \* span/g)].map((m) => m[1] + ',' + m[2]);
        for (const taps of [1, 4, 9, 16]) {
            const w = offs(mwsrWgsl({ mode: 'down', taps }));
            expect(w.length).toBe(taps);
            expect(offs(mwsrGlsl({ mode: 'down', taps }))).toEqual(w);
        }
        expect(mwsrGlsl({ mode: 'down', overrides: { LINEAR_LIGHT: 0, R_DOWN: 1.25 } })).toContain(
            'const float R_DOWN = 1.25;',
        );
        // the key both renderers keep a regime's pipeline or program under
        expect(mwsrRegimeKey({ mode: 'up', taps: 5 })).toBe('up');
        expect(mwsrRegimeKey({ mode: 'down', taps: 9 })).toBe('down9');
        expect(new Set(mwsrRegimes().map(mwsrRegimeKey)).size).toBe(mwsrRegimes().length);
    });

    it('copies no constant of the kernels it was written next to (plan §10.2)', () => {
        for (const bad of [
            '25.0 / 16.0',
            '2.0 / 5.0',
            '(x - 1.0) * (x - 4.0)',
            '0.55',
            '2.181818',
            '10.14185',
            '0.1875',
            '6.0 / 255.0',
            '8.0 / 255.0',
            '23.0 / 255.0',
        ]) {
            for (const text of [tex, down, glsl, glslDown]) expect(text, bad).not.toContain(bad);
        }
    });

    it('packs the uniform block the way the text reads it', () => {
        const u = mwsrUniforms(1280, 720, 2560, 1440);
        expect(u.length).toBe(MWSR_UNIFORM_FLOATS);
        expect(u[0]).toBeCloseTo(1 / 1280, 7);
        expect(u[1]).toBeCloseTo(1 / 720, 7);
        expect(u[2]).toBe(2);
        expect(u[3]).toBe(2);
        expect(u[4]).toBeCloseTo(0.05, 6);
        expect(u[5]).toBe(2); // the sharpness of the lab's J31 (23/10/2026)
        const v = mwsrUniforms(1920, 1080, 2560, 1440, { tau: 0.03, sharp: 0.5 });
        expect(v[2]).toBeCloseTo(4 / 3, 6);
        expect(v[4]).toBeCloseTo(0.03, 6);
        expect(v[5]).toBe(0.5);
        const d = mwsrUniforms(2560, 1440, 1280, 720);
        expect(d[2]).toBe(0.5);
        expect(d[3]).toBe(0.5);
    });
});
