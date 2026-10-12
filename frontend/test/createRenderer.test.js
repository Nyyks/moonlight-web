/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * The real renderers touch WebGPU/Canvas/<video> and are out of scope; we mock
 * them and assert only the selection/fallback logic of createVideoRenderer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/stream/renderers/Canvas2DRenderer.js', () => ({
    Canvas2DRenderer: { create: vi.fn(async () => ({ kind: 'canvas2d' })) },
}));
vi.mock('../js/stream/renderers/WebGpuRenderer.js', () => ({
    WebGpuRenderer: { create: vi.fn(async () => ({ kind: 'webgpu' })) },
}));
vi.mock('../js/stream/renderers/VideoElementRenderer.js', () => ({
    VideoElementRenderer: { create: vi.fn(async () => ({ kind: 'video' })) },
}));
vi.mock('../js/stream/renderers/WebGlRenderer.js', () => ({
    WebGlRenderer: { create: vi.fn(async () => ({ kind: 'webgl' })) },
    WEBGL_ALGOS: ['gl-fsr1', 'gl-sgsr', 'gl-nis'],
}));

import {
    createVideoRenderer,
    geckoPresentsOnPlainWebGl,
} from '../js/stream/renderers/createRenderer.js';
import { Canvas2DRenderer } from '../js/stream/renderers/Canvas2DRenderer.js';
import { WebGpuRenderer } from '../js/stream/renderers/WebGpuRenderer.js';
import { VideoElementRenderer } from '../js/stream/renderers/VideoElementRenderer.js';
import { WebGlRenderer } from '../js/stream/renderers/WebGlRenderer.js';

const canvas = {};

describe('createVideoRenderer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        WebGpuRenderer.create.mockResolvedValue({ kind: 'webgpu' });
        VideoElementRenderer.create.mockResolvedValue({ kind: 'video' });
        Canvas2DRenderer.create.mockResolvedValue({ kind: 'canvas2d' });
        WebGlRenderer.create.mockResolvedValue({ kind: 'webgl' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('routes HDR to the <video> renderer when supported', async () => {
        vi.stubGlobal('MediaStreamTrackGenerator', function () {});
        vi.stubGlobal('navigator', { gpu: {} });
        const r = await createVideoRenderer(canvas, { hdr: true, videoEl: {}, webgpu: true });
        expect(r.kind).toBe('video');
        expect(VideoElementRenderer.create).toHaveBeenCalled();
    });

    it('prefers WebGPU when available', async () => {
        vi.stubGlobal('navigator', { gpu: {} });
        const r = await createVideoRenderer(canvas, { webgpu: true });
        expect(r.kind).toBe('webgpu');
    });

    it('falls back to Canvas2D when WebGPU is unavailable', async () => {
        vi.stubGlobal('navigator', {});
        const r = await createVideoRenderer(canvas, { webgpu: true });
        expect(r.kind).toBe('canvas2d');
    });

    it('falls back to Canvas2D when WebGPU init throws', async () => {
        vi.stubGlobal('navigator', { gpu: {} });
        WebGpuRenderer.create.mockRejectedValue(new Error('no device'));
        const r = await createVideoRenderer(canvas, { webgpu: true });
        expect(r.kind).toBe('canvas2d');
    });

    it('falls back from a failing <video> HDR renderer to the canvas path', async () => {
        vi.stubGlobal('MediaStreamTrackGenerator', function () {});
        vi.stubGlobal('navigator', { gpu: {} });
        VideoElementRenderer.create.mockRejectedValue(new Error('no MSTG'));
        const r = await createVideoRenderer(canvas, { hdr: true, videoEl: {}, webgpu: true });
        expect(r.kind).toBe('webgpu'); // HDR failed → WebGPU still preferred
    });

    it('presents the plain picture on WebGL with no pass in Firefox', async () => {
        vi.stubGlobal('navigator', {});
        const r = await createVideoRenderer(canvas, { plainWebGl: true, algo: 'off' });
        expect(r.kind).toBe('webgl');
        expect(WebGlRenderer.create.mock.calls[0][1].algo).toBe('off');
    });

    it('falls back to Canvas2D when that WebGL context is refused', async () => {
        vi.stubGlobal('navigator', {});
        WebGlRenderer.create.mockRejectedValue(new Error('WebGL2 unavailable'));
        const r = await createVideoRenderer(canvas, { plainWebGl: true, algo: 'off' });
        expect(r.kind).toBe('canvas2d');
    });

    it('keeps Canvas2D for the plain picture everywhere else', async () => {
        vi.stubGlobal('navigator', {});
        const r = await createVideoRenderer(canvas, { algo: 'off' });
        expect(r.kind).toBe('canvas2d');
        expect(WebGlRenderer.create).not.toHaveBeenCalled();
    });
});

/**
 * Firefox's 2D canvas copies each decoded frame on the main thread: 55 ms a
 * 1080p frame on the N95, an IDR every 300 ms at 60 fps (12/10/2026).
 */
describe('geckoPresentsOnPlainWebGl', () => {
    const ff = { gecko: true, hdr: false, algo: 'off', webgpu: false, sink: false };

    it('moves the plain SDR picture to WebGL in Firefox', () => {
        expect(geckoPresentsOnPlainWebGl(ff)).toBe(true);
    });

    it('leaves every other browser, and every other choice, as it was', () => {
        expect(geckoPresentsOnPlainWebGl({ ...ff, gecko: false })).toBe(false);
        // HDR has its own routing; an enhancer picks its own renderer.
        expect(geckoPresentsOnPlainWebGl({ ...ff, hdr: true })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, algo: 'gl-fsr1' })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, webgpu: true })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, sink: true })).toBe(false);
        // The debug menu's Canvas2D, and mw_force_2d, stay Canvas2D.
        expect(geckoPresentsOnPlainWebGl({ ...ff, forceCanvas2d: true })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, devCanvas2d: true })).toBe(false);
    });
});
