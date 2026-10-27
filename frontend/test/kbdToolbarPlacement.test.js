/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The touch keyboard bar sits right above the soft keyboard, whichever way the
 * browser makes room for it.
 *
 * Safari on an iPhone keeps the layout viewport and hides its bottom; Chrome on
 * an iPhone (27/10/2026) shrinks the layout viewport with the visible area.
 * The bar was parked by its bottom, from the layout viewport's: there it went
 * to the top of the screen, over Stop, or never showed at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../js/ui/Toast.js', () => ({ Toast: { warning: () => {} } }));
vi.mock('../js/i18n/i18n.js', () => ({ t: (key) => key, applyTranslations: () => {} }));

const { StreamViewKeyboard } = await import('../js/ui/StreamViewKeyboard.js');

const BAR = 48;

/** The bar and the stream element, on a stand-in for the StreamView. */
function view() {
    const v = Object.create(StreamViewKeyboard.prototype);
    v._rootEl = document.createElement('div');
    v._sendKeyEvent = () => {};
    v._buildKbToolbar();
    Object.defineProperty(v._kbToolbar, 'offsetHeight', { get: () => BAR });
    v.streamEl = document.createElement('div');
    v._positionStatsOverlay = () => {};
    return v;
}

/** The page as the browser shows it: layout height, visible height and offset. */
function viewport(innerHeight, height, offsetTop = 0) {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight);
    Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: { height, offsetTop },
    });
}

const shown = (v) => v._kbToolbar.classList.contains('visible');

afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty('--kbd-inset');
});

describe('touch keyboard bar placement', () => {
    it('sits above a keyboard that hides the bottom of the layout viewport', () => {
        const v = view();
        viewport(800, 800);
        v._handleViewportResize();
        v._kbdVisible = true;
        viewport(800, 450);
        v._handleViewportResize();
        expect(shown(v)).toBe(true);
        expect(v._kbToolbar.style.top).toBe(450 - BAR + 'px');
        expect(v.streamEl.style.height).toBe(450 - BAR + 'px');
        expect(document.documentElement.style.getPropertyValue('--kbd-inset')).toBe(
            350 + BAR + 'px',
        );
    });

    it('sits above a keyboard that shrinks the layout viewport with it', () => {
        const v = view();
        viewport(800, 800);
        v._handleViewportResize();
        v._kbdVisible = true;
        viewport(450, 450);
        v._handleViewportResize();
        expect(shown(v)).toBe(true);
        expect(v._kbToolbar.style.top).toBe(450 - BAR + 'px');
        // Nothing of the layout viewport is hidden: toasts only clear the bar.
        expect(document.documentElement.style.getPropertyValue('--kbd-inset')).toBe(BAR + 'px');
    });

    it('rests the picture a few pixels above the bar, and back when the keyboard closes', () => {
        const v = view();
        v.canvasArea = document.createElement('div');
        Object.defineProperty(v.canvasArea, 'offsetWidth', { get: () => 390 });
        Object.defineProperty(v.canvasArea, 'offsetHeight', { get: () => 400 });
        v._displayEl = () => null;
        v._surfaceIntrinsic = () => [1920, 1080];
        v._invalidateMediaRect = vi.fn();
        viewport(800, 800);
        v._handleViewportResize();
        v._kbdVisible = true;
        viewport(450, 450);
        v._handleViewportResize();
        // 1920×1080 across 390 px is 219 px tall: centred, 90 px of black
        // would sit under it; seated, only 4.
        expect(v.canvasArea.style.transform).toBe('translateY(86px)');
        expect(v._invalidateMediaRect).toHaveBeenCalled();
        v._kbdVisible = false;
        viewport(800, 800);
        v._handleViewportResize();
        expect(v.canvasArea.style.transform).toBe('');
    });

    it('goes when the keyboard closes, and a new page height is learnt', () => {
        const v = view();
        viewport(800, 800);
        v._handleViewportResize();
        v._kbdVisible = true;
        viewport(450, 450);
        v._handleViewportResize();
        v._kbdVisible = false;
        viewport(390, 390); // turned to landscape, keyboard down
        v._handleViewportResize();
        expect(shown(v)).toBe(false);
    });
});
