/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * A phone under a stream reads its screen low (util/RefreshRate.js, "Under
 * load"): the realme Note 60's 60 Hz as 35-39, the iPhone 13 Pro's 120 as
 * 112-116, and the host ran 56-58 fps off that (22/10/2026). A lower reading
 * whose deltas are not one tight cluster is the page, not the screen; a window
 * that really moved to a slower screen still reads clean, and is believed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

async function load() {
    vi.resetModules();
    vi.doMock('../js/util/BrowserDetect.js', async () => ({
        ...(await vi.importActual('../js/util/BrowserDetect.js')),
        IS_TV: false,
    }));
    return import('../js/util/RefreshRate.js');
}

/** rAF handing out the deltas of `next()` on a clock coarsened to `grainMs`. */
function ticks(next, grainMs = 0) {
    let t = 1000;
    vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((cb) =>
            Promise.resolve().then(() => {
                t += next();
                cb(grainMs ? Math.floor(t / grainMs) * grainMs : t);
            }),
        ),
    );
}

/** A screen at `hz`, one refresh in `skipEvery` shown twice (0: none). */
function screenAt(hz, grainMs = 0, skipEvery = 0) {
    let i = 0;
    ticks(() => (skipEvery && ++i % skipEvery === 0 ? 2 : 1) * (1000 / hz), grainMs);
}

describe('RefreshRate under load', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.doUnmock('../js/util/BrowserDetect.js');
        localStorage.clear();
    });

    it('keeps 60 Hz when most frames are skipped (the realme)', async () => {
        const rate = await load();
        screenAt(60);
        expect(await rate.measureRefreshRate()).toBe(60000);

        // Two frames in three on the doubled period: read 37.5 Hz before.
        let i = 0;
        ticks(() => (++i % 3 === 0 ? 1 : 2) * (1000 / 60));
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await rate.measureRefreshRate()).toBe(60000);
        expect(rate.currentRefreshMilliHz()).toBe(60000);
        expect(info).toHaveBeenCalledWith(expect.stringContaining('read under load'));
    });

    it('keeps 120 Hz when frames land between two refreshes (the iPhone)', async () => {
        const rate = await load();
        screenAt(120, 1);
        const at120 = await rate.measureRefreshRate();
        expect(Math.abs(at120 - 120000)).toBeLessThan(600);

        // One delta in three at 12.5 ms: read 112 Hz before.
        let i = 0;
        ticks(() => (++i % 3 === 0 ? 12.5 : 1000 / 120), 1);
        vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await rate.measureRefreshRate()).toBe(at120);
    });

    it('believes a window that moved to a slower screen', async () => {
        const rate = await load();
        screenAt(165, 1);
        expect(Math.round((await rate.measureRefreshRate()) / 1000)).toBe(165);

        // On a millisecond clock, with a skipped refresh now and then.
        screenAt(144, 1, 25);
        expect(Math.round((await rate.measureRefreshRate()) / 1000)).toBe(144);

        screenAt(60, 1);
        expect(Math.round((await rate.measureRefreshRate()) / 1000)).toBe(60);
    });

    it('takes a 240 Hz panel on a millisecond clock as clean', async () => {
        const rate = await load();
        screenAt(240);
        expect(await rate.measureRefreshRate()).toBe(240000);
        screenAt(239, 1);
        expect(Math.round((await rate.measureRefreshRate()) / 1000)).toBe(239);
    });

    it('takes a first reading as it comes, and a higher one at once', async () => {
        const rate = await load();
        let i = 0;
        ticks(() => (++i % 3 === 0 ? 1 : 2) * (1000 / 60));
        const first = await rate.measureRefreshRate();
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(60000);

        screenAt(60);
        expect(await rate.measureRefreshRate()).toBe(60000);
    });
});
