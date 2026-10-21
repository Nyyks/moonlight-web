/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

/**
 * WebGpuRenderer — the frame's way in when the browser refuses
 * importExternalTexture (Chrome on a machine whose decoded frames cannot be
 * shared with WebGPU, 21/10/2026: "Failed to import texture from video" on
 * every frame, a black canvas and a console line per frame). The renderer is
 * driven against a fake device: what matters is which path draw() takes, not
 * what a GPU would draw.
 */
/* global console, createImageBitmap, GPUTextureUsage */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebGpuRenderer } from '../js/stream/renderers/WebGpuRenderer.js';

function fakeGpu({ importThrows = false } = {}) {
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
    const encoder = {
        beginRenderPass: vi.fn(() => pass),
        finish: () => ({}),
        copyTextureToBuffer: vi.fn(),
    };
    const textures = [];
    const device = {
        features: new Set(),
        limits: {},
        lost: new Promise(() => {}),
        addEventListener() {},
        destroy() {},
        createSampler: () => ({}),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
        createRenderPipeline: () => ({}),
        createComputePipeline: () => ({}),
        createBindGroup: vi.fn(() => ({})),
        createBuffer: () => ({
            destroy() {},
            mapAsync: async () => {},
            getMappedRange: () => new ArrayBuffer(256),
            unmap() {},
        }),
        createTexture: vi.fn((desc) => {
            const t = { desc, createView: () => ({}), destroy() {} };
            textures.push(t);
            return t;
        }),
        createCommandEncoder: vi.fn(() => encoder),
        importExternalTexture: vi.fn(() => {
            if (importThrows) throw new Error('Failed to import texture from video');
            return {};
        }),
        queue: {
            submit: vi.fn(),
            writeBuffer: vi.fn(),
            writeTexture: vi.fn(),
            onSubmittedWorkDone: async () => {},
            copyExternalImageToTexture: vi.fn(),
        },
    };
    const adapter = {
        info: { vendor: 'test' },
        features: new Set(),
        limits: {},
        requestDevice: async () => device,
    };
    const ctx = {
        configure: vi.fn(),
        unconfigure: vi.fn(),
        getCurrentTexture: () => ({ createView: () => ({}) }),
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext: (kind) => (kind === 'webgpu' ? ctx : null),
    };
    return { device, adapter, encoder, pass, textures, canvas, ctx };
}

function frame() {
    return {
        displayWidth: 640,
        displayHeight: 360,
        codedWidth: 640,
        codedHeight: 360,
        timestamp: 0,
        format: 'RGBA',
        close: vi.fn(),
    };
}

async function renderer(gpu, algo) {
    Object.defineProperty(globalThis.navigator, 'gpu', {
        value: {
            requestAdapter: async () => gpu.adapter,
            getPreferredCanvasFormat: () => 'bgra8unorm',
        },
        configurable: true,
    });
    const r = await WebGpuRenderer.create(gpu.canvas, { algo, videoCodec: 'h264' });
    r.setOutputSize(1280, 720);
    return r;
}

describe('WebGpuRenderer — a refused importExternalTexture', () => {
    let bitmaps;
    beforeEach(() => {
        vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
        vi.stubGlobal('GPUTextureUsage', {
            COPY_SRC: 1,
            COPY_DST: 2,
            TEXTURE_BINDING: 4,
            STORAGE_BINDING: 8,
            RENDER_ATTACHMENT: 16,
        });
        vi.stubGlobal('GPUBufferUsage', {
            MAP_READ: 1,
            MAP_WRITE: 2,
            COPY_SRC: 4,
            COPY_DST: 8,
            UNIFORM: 64,
            STORAGE: 128,
            QUERY_RESOLVE: 512,
        });
        vi.stubGlobal('GPUMapMode', { READ: 1, WRITE: 2 });
        bitmaps = [];
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async (f) => {
                const b = { width: f.displayWidth, height: f.displayHeight, close: vi.fn() };
                bitmaps.push(b);
                return b;
            }),
        );
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        delete globalThis.navigator.gpu;
    });

    it('imports the frame when the browser allows it, nothing copied', async () => {
        const gpu = fakeGpu();
        const r = await renderer(gpu, 'off');
        const f = frame();
        await r.draw(f);
        expect(gpu.device.importExternalTexture).toHaveBeenCalledTimes(1);
        expect(createImageBitmap).not.toHaveBeenCalled();
        expect(gpu.device.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
        expect(r.lastDraw.path).toBe('off');
        expect(f.close).toHaveBeenCalledTimes(1);
    });

    it('copies the frame through an ImageBitmap into inputTex when the import throws, and warns once', async () => {
        const gpu = fakeGpu({ importThrows: true });
        const r = await renderer(gpu, 'off');
        const f1 = frame();
        await r.draw(f1);
        // the copy: the bitmap of the frame, into the input texture, at the frame's size
        expect(createImageBitmap).toHaveBeenCalledWith(f1);
        const copy = gpu.device.queue.copyExternalImageToTexture;
        expect(copy).toHaveBeenCalledTimes(1);
        const [src, dst, size] = copy.mock.calls[0];
        expect(src.source).toBe(bitmaps[0]);
        expect(dst.texture.desc.size).toEqual({ width: 640, height: 360 });
        expect(dst.texture.desc.usage & GPUTextureUsage.COPY_DST).toBeTruthy();
        expect(size).toEqual({ width: 640, height: 360 });
        expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
        expect(f1.close).toHaveBeenCalledTimes(1);
        // the picture still goes to the canvas, by the texture copy
        expect(gpu.pass.draw).toHaveBeenCalledTimes(1);
        expect(gpu.device.queue.submit).toHaveBeenCalledTimes(1);
        expect(r.lastDraw.path).toBe('off+bitmap');
        // one line, not one per frame; the import is not asked again at once
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(console.error).not.toHaveBeenCalled();
        await r.draw(frame());
        await r.draw(frame());
        expect(gpu.device.importExternalTexture).toHaveBeenCalledTimes(1);
        expect(copy).toHaveBeenCalledTimes(3);
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('tries the import again later, and leaves the bitmap path when it works', async () => {
        const gpu = fakeGpu({ importThrows: true });
        const r = await renderer(gpu, 'off');
        await r.draw(frame());
        expect(r.lastDraw.path).toBe('off+bitmap');
        // long after the refusal, the import is asked again — and now works
        r._drawCount += 300;
        gpu.device.importExternalTexture.mockImplementation(() => ({}));
        await r.draw(frame());
        expect(gpu.device.importExternalTexture).toHaveBeenCalledTimes(2);
        expect(r.lastDraw.path).toBe('off');
        await r.draw(frame());
        expect(gpu.device.importExternalTexture).toHaveBeenCalledTimes(3);
        expect(gpu.device.queue.copyExternalImageToTexture).toHaveBeenCalledTimes(1);
    });

    it('skips pass 0 on the upscaler path when the copy already filled inputTex', async () => {
        const ok = fakeGpu();
        const r1 = await renderer(ok, 'sgsr');
        await r1.draw(frame());
        const passesWithImport = ok.encoder.beginRenderPass.mock.calls.length;
        expect(passesWithImport).toBe(2); // pass 0 then the kernel

        const refused = fakeGpu({ importThrows: true });
        const r2 = await renderer(refused, 'sgsr');
        await r2.draw(frame());
        expect(refused.encoder.beginRenderPass).toHaveBeenCalledTimes(1); // the kernel alone
        expect(refused.device.queue.copyExternalImageToTexture).toHaveBeenCalledTimes(1);
        expect(r2.lastDraw.path).toBe('sgsr+bitmap');
    });

    it('logs a failing draw once per message, not once per frame', async () => {
        const gpu = fakeGpu();
        const r = await renderer(gpu, 'off');
        gpu.device.createCommandEncoder.mockImplementation(() => {
            throw new Error('boom');
        });
        await r.draw(frame());
        await r.draw(frame());
        await r.draw(frame());
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(String(console.error.mock.calls[0][0])).toContain('boom');
        gpu.device.createCommandEncoder.mockImplementation(() => {
            throw new Error('other');
        });
        await r.draw(frame());
        expect(console.error).toHaveBeenCalledTimes(2);
    });
});
