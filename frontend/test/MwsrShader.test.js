import { describe, it, expect } from 'vitest';
import {
    MWSR_CONSTANTS,
    MWSR_OVERRIDES,
    MWSR_OVERRIDE_SPEC,
    MWSR_UNIFORM_FLOATS,
    mwsrUniforms,
    mwsrWgsl,
} from '../js/stream/renderers/MwsrShader.js';

describe('the mwsr shader text', () => {
    const tex = mwsrWgsl({ feed: 'tex' });
    const ext = mwsrWgsl({ feed: 'ext' });

    it('reads either feed with the same kernel', () => {
        expect(tex).toContain('var tex : texture_2d<f32>;');
        expect(tex).toContain('textureSampleLevel(tex, samp, uv, 0.0)');
        expect(ext).toContain('var tex : texture_external;');
        expect(ext).toContain('textureSampleBaseClampToEdge(tex, samp, uv)');
        const kernel = (s) => s.slice(s.indexOf('override '));
        expect(kernel(tex)).toBe(kernel(ext));
        expect(mwsrWgsl()).toBe(tex);
        expect(() => mwsrWgsl({ feed: 'yuv' })).toThrow(/feed/);
    });

    it('declares every override with its default', () => {
        for (const [name, [type, value]] of Object.entries(MWSR_OVERRIDE_SPEC)) {
            const lit =
                type === 'u32' ? `${value}u` : Number.isInteger(value) ? `${value}.0` : `${value}`;
            expect(tex).toContain(`override ${name} : ${type} = ${lit};`);
            expect(MWSR_OVERRIDES[name]).toBe(value);
        }
        expect(tex).toContain('const LUMA : vec3f = vec3f(0.25, 0.625, 0.125);');
        expect(MWSR_CONSTANTS.LUMA.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    });

    it('takes its derivatives before the branch, and samples with an explicit level only', () => {
        const fs = tex.slice(tex.indexOf('@fragment'));
        const vote = fs.indexOf('dpdxCoarse');
        const branch = fs.indexOf('if (flat) {');
        expect(vote).toBeGreaterThan(0);
        expect(branch).toBeGreaterThan(vote);
        expect(fs.slice(branch)).not.toMatch(/dpd[xy]|fwidth/);
        expect(tex).not.toMatch(/textureSample\(/);
    });

    it('has a half-precision variant for the edge path only', () => {
        const half = mwsrWgsl({ feed: 'ext', half: true });
        expect(half.startsWith('enable f16;')).toBe(true);
        expect(half).toContain('alias hf = f16;');
        expect(half).toContain('alias h3 = vec3<f16>;');
        expect(tex.startsWith('enable')).toBe(false);
        expect(tex).toContain('alias hf = f32;');
        // the vote and the frame stay in f32 whatever the variant
        for (const text of [tex, half]) {
            expect(text).toContain('let gx = dpdxCoarse(lC) * u.scale.x;');
            expect(text).toContain('let n = vec2f(gx, gy) * inverseSqrt(');
            expect(text).toContain('var R = vec3f(blend(Ch, T1, T2, X1, X2, wT, wX));');
        }
        const kernel = (s) => s.slice(s.indexOf('override '));
        expect(kernel(half)).toBe(kernel(mwsrWgsl({ feed: 'tex', half: true })));
    });

    it('uses no gather, no discard, no loop, no dynamic indexing (plan §3.4)', () => {
        expect(tex).not.toMatch(/textureGather|discard|\bfor\s*\(|\bloop\b|\bwhile\b|\[\s*i\s*\]/);
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
            expect(tex, bad).not.toContain(bad);
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
        expect(u[5]).toBe(1);
        const v = mwsrUniforms(1920, 1080, 2560, 1440, { tau: 0.03, sharp: 0.5 });
        expect(v[2]).toBeCloseTo(4 / 3, 6);
        expect(v[4]).toBeCloseTo(0.03, 6);
        expect(v[5]).toBe(0.5);
    });
});
