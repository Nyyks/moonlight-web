/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * The protocol below us is positional: the key's PHYSICAL position is sent as a
 * US virtual key, and the host resolves it through its own layout. That types
 * the wrong characters the moment the two layouts disagree — an AZERTY viewer
 * on a QWERTY host presses "azerty" and reads "qwerty".
 *
 * The client answers with two things it can actually know: `char`, the
 * character its layout produced, and `nonUs`, whether the US layout puts
 * something else at that position. It picks no mechanism — only the backend
 * knows what kind of host is listening (see InputMsg::resolveKey).
 */

const VK_Q = 0x51;
const VK_E = 0x45;
const VK_1 = 0x31;
const VK_SPACE = 0x20;

/** Minimal stand-in exposing just what the keyboard path touches. */
function keySink(overrides = {}) {
    const sent = [];
    return {
        sent,
        webrtc: { send: (m) => sent.push(m) },
        _sendToHost: (m) => sent.push(m),
        _heldPhysKeys: new Map(),
        _heldMouseButtons: new Set(),
        _metaTapCodes: new Set(),
        _appleKeyboard: false,
        _quitting: false,
        _pendingClipboardWrite: null,
        _kbdCapture: null,
        _locksSynced: true,
        _cssFullscreen: false,
        _clipboardEnabled: false,
        _layoutMap: null,
        _gamingMode: false,
        _gamepadManager: null,
        _pendingPasteKey: null,
        _suppressPasteKeyUpCode: null,
        handleKeyDown: StreamView.prototype.handleKeyDown,
        handleKeyUp: StreamView.prototype.handleKeyUp,
        _sendKeyEvent: StreamView.prototype._sendKeyEvent,
        _reconcileModifiers: StreamView.prototype._reconcileModifiers,
        _forgetHeldKey: StreamView.prototype._forgetHeldKey,
        _holdsThroughStall: StreamView.prototype._holdsThroughStall,
        _sendInputState: StreamView.prototype._sendInputState,
        handleKeyPress: StreamView.prototype.handleKeyPress,
        _deferComposedKey: StreamView.prototype._deferComposedKey,
        _flushComposedKey: StreamView.prototype._flushComposedKey,
        _dropComposedKey: StreamView.prototype._dropComposedKey,
        _deadPending: false,
        _composedKey: null,
        ...overrides,
    };
}

/** A KeyboardEvent-shaped plain object. */
function ev(code, key, mods = {}) {
    return {
        target: {},
        code,
        key,
        keyCode: 0,
        repeat: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        getModifierState: () => false,
        preventDefault() {},
        ...mods,
    };
}

describe('clientChar — what the client says it meant', () => {
    it('says nothing for a key that has a name rather than a character', () => {
        for (const key of ['Enter', 'ArrowUp', 'F1', 'Shift', 'Escape', 'Dead'])
            expect(StreamView.clientChar(ev('Whatever', key))).toBeNull();
    });

    it('reports the character on every printable key, a US client included', () => {
        // The native host resolves the CHARACTER in its own layout, so it needs
        // one even when nothing diverges: a US viewer on a French host presses
        // the key marked A, means 'q', and the position types 'a'. Nothing
        // about that keystroke differs from US, and it is wrong all the same.
        expect(StreamView.clientChar(ev('KeyQ', 'q'))).toEqual({ char: 'q', nonUs: false });
        expect(StreamView.clientChar(ev('Digit1', '1'))).toEqual({ char: '1', nonUs: false });
        expect(StreamView.clientChar(ev('Space', ' '))).toEqual({ char: ' ', nonUs: false });
    });

    it('marks a US client as agreeing, on every printable key', () => {
        // `nonUs` is what keeps the Sunshine path off a US viewer's keystrokes.
        for (const [code, plain, shifted] of [
            ['KeyQ', 'q', 'Q'],
            ['KeyA', 'a', 'A'],
            ['Digit1', '1', '!'],
            ['Slash', '/', '?'],
            ['Backquote', '`', '~'],
        ]) {
            expect(StreamView.clientChar(ev(code, plain)).nonUs).toBe(false);
            expect(StreamView.clientChar(ev(code, shifted, { shiftKey: true })).nonUs).toBe(false);
        }
    });

    it('marks an AZERTY key that disagrees with its US position', () => {
        expect(StreamView.clientChar(ev('KeyQ', 'a'))).toEqual({ char: 'a', nonUs: true });
        expect(StreamView.clientChar(ev('KeyW', 'z'))).toEqual({ char: 'z', nonUs: true });
        expect(StreamView.clientChar(ev('KeyA', 'q'))).toEqual({ char: 'q', nonUs: true });
        // The digit row is where AZERTY diverges the hardest: unshifted it types
        // symbols, and the shift state that reaches them differs per layout.
        expect(StreamView.clientChar(ev('Digit1', '&'))).toEqual({ char: '&', nonUs: true });
        expect(StreamView.clientChar(ev('Digit1', '1', { shiftKey: true }))).toEqual({
            char: '1',
            nonUs: true,
        });
    });

    it('leaves the keys AZERTY shares with US marked as agreeing', () => {
        for (const [code, key] of [
            ['KeyE', 'e'],
            ['KeyR', 'r'],
            ['KeyT', 't'],
            ['Space', ' '],
        ])
            expect(StreamView.clientChar(ev(code, key)).nonUs).toBe(false);
    });

    it('always marks an AltGr character, which no US position carries', () => {
        // Windows reports AltGr as Ctrl+Alt, so this has to be decided before
        // anything treats the keystroke as a chord.
        const e = ev('KeyE', '€', {
            ctrlKey: true,
            altKey: true,
            getModifierState: (name) => name === 'AltGraph',
        });
        expect(StreamView.clientChar(e)).toEqual({ char: '€', nonUs: true });
    });

    it('marks the letter of a Ctrl chord, which is the bug users actually hit', () => {
        // Ctrl+A on AZERTY sits at the US Q position: sent positionally it
        // reaches the host as Ctrl+Q.
        expect(StreamView.clientChar(ev('KeyQ', 'a', { ctrlKey: true }))).toEqual({
            char: 'a',
            nonUs: true,
        });
    });
});

describe('the wire message', () => {
    it('carries the character and the divergence flag on a divergent key', () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a'));

        expect(v.sent).toHaveLength(1);
        expect(v.sent[0].type).toBe('keydown');
        expect(v.sent[0].code).toBe('KeyQ');
        // The position is still there: the backend needs it for a host that can
        // only be addressed positionally.
        expect(v.sent[0].keyCode).toBe(VK_Q);
        expect(v.sent[0].char).toBe('a');
        expect(v.sent[0].nonUs).toBe(true);
    });

    it('carries the character on an agreeing key too, flagged as agreeing', () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyE', 'e'));
        expect(v.sent[0].keyCode).toBe(VK_E);
        expect(v.sent[0].char).toBe('e');
        expect(v.sent[0].nonUs).toBe(false);
    });

    it('carries no character at all for a named key', () => {
        const v = keySink();
        v.handleKeyDown(ev('ArrowUp', 'ArrowUp'));
        expect(v.sent[0].char).toBeNull();
        expect(v.sent[0].nonUs).toBe(false);
    });

    it('replays the press character on the release, never the release event', () => {
        // Releasing Shift before the letter changes what e.key reads. A release
        // resolved differently from its press is a different key to Sunshine —
        // which identifies one by (keyCode, flags) — so the press never comes
        // back up and the host holds it forever.
        const v = keySink();
        v.handleKeyDown(ev('Digit1', '1', { shiftKey: true }));
        expect(v.sent[0].char).toBe('1');

        v.sent.length = 0;
        v.handleKeyUp(ev('Digit1', '&')); // Shift already gone
        expect(v.sent).toHaveLength(1);
        expect(v.sent[0].type).toBe('keyup');
        expect(v.sent[0].keyCode).toBe(VK_1);
        expect(v.sent[0].char).toBe('1');
        expect(v.sent[0].nonUs).toBe(true);
    });

    it('repeats the press the host received, character included', () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a'));
        v.sent.length = 0;

        v.handleKeyDown(ev('KeyQ', 'a', { repeat: true }));
        expect(v.sent).toHaveLength(1);
        expect(v.sent[0]).toMatchObject({
            type: 'keydown',
            keyCode: VK_Q,
            char: 'a',
            nonUs: true,
        });
    });

    it('reports the character in the held-input heartbeat', () => {
        // Same reason as the release: a re-press the watchdog resolves down a
        // different path than the original press would strand the key.
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a'));
        v.handleKeyDown(ev('Space', ' '));
        v.sent.length = 0;

        v._sendInputState();
        expect(v.sent).toHaveLength(1);
        const state = v.sent[0];
        expect(state.type).toBe('inputstate');
        expect(state.keys).toEqual([
            expect.objectContaining({ keyCode: VK_Q, char: 'a', nonUs: true }),
            expect.objectContaining({ keyCode: VK_SPACE, char: ' ', nonUs: false }),
        ]);
    });
});

describe('a dead key and what it composes', () => {
    // Chrome on Windows reports the keystroke after a dead key with the key's
    // own character — ' ' for the Space of "~", 'n' for the n of "ñ" — and puts
    // the composition in the keypress alone. The native host, which types
    // characters, got a space for every tilde (12/10/2026, AZERTY → UM790Pro).
    afterEach(() => vi.useRealTimers());

    const altGr = { ctrlKey: true, altKey: true, getModifierState: (n) => n === 'AltGraph' };

    function deadThen(v, code, key) {
        v.handleKeyDown(ev('Digit2', 'Dead', altGr));
        const next = ev(code, key);
        let prevented = false;
        next.preventDefault = () => (prevented = true);
        v.handleKeyDown(next);
        return () => prevented;
    }

    it('sends the composed tilde on the Space, and leaves the keydown to the browser', () => {
        const v = keySink();
        const prevented = deadThen(v, 'Space', ' ');
        // The dead key went out, flagged; the Space is held back, and its
        // keydown not cancelled — or the keypress would never fire.
        expect(v.sent).toHaveLength(1);
        expect(v.sent[0]).toMatchObject({ code: 'Digit2', dead: true });
        expect(prevented()).toBe(false);

        const press = ev('Space', '~');
        let cancelled = false;
        press.preventDefault = () => (cancelled = true);
        v.handleKeyPress(press);
        expect(cancelled).toBe(true);

        v.handleKeyUp(ev('Space', ' '));
        expect(v.sent.map((m) => [m.type, m.code, m.char])).toEqual([
            ['keydown', 'Digit2', null],
            ['keydown', 'Space', '~'],
            ['keyup', 'Space', '~'],
        ]);
        // The position is kept for a host that composes on its own side.
        expect(v.sent[1].keyCode).toBe(VK_SPACE);
        expect(v.sent[1].nonUs).toBe(true);
        expect(v.sent[1].dead).toBe(false);
    });

    it('sends ñ on the n', () => {
        const v = keySink();
        deadThen(v, 'KeyN', 'n');
        v.handleKeyPress(ev('KeyN', 'ñ'));
        v.handleKeyUp(ev('KeyN', 'n'));
        expect(v.sent[1]).toMatchObject({ type: 'keydown', code: 'KeyN', char: 'ñ' });
    });

    it('keeps the key its own character when the pair does not compose', () => {
        const v = keySink();
        deadThen(v, 'KeyW', 'z');
        v.handleKeyPress(ev('KeyW', '~'));
        v.handleKeyPress(ev('KeyW', 'z'));
        v.handleKeyUp(ev('KeyW', 'z'));
        expect(v.sent[1]).toMatchObject({ type: 'keydown', code: 'KeyW', char: 'z' });
    });

    it('sends the key as it read when no keypress comes', () => {
        // A browser that composes in the keydown itself (Firefox) and fires no
        // keypress the page can see: the timer lets the press go as it was.
        vi.useFakeTimers();
        const v = keySink();
        deadThen(v, 'KeyN', 'ñ');
        expect(v.sent).toHaveLength(1);
        vi.advanceTimersByTime(60);
        expect(v.sent[1]).toMatchObject({ type: 'keydown', code: 'KeyN', char: 'ñ' });
    });

    it('lets the held-back press go before the next one', () => {
        const v = keySink();
        deadThen(v, 'Space', ' ');
        v.handleKeyPress(ev('Space', '~'));
        v.handleKeyDown(ev('KeyE', 'e'));
        expect(v.sent.map((m) => m.code)).toEqual(['Digit2', 'Space', 'KeyE']);
    });

    it('holds back nothing once the composition is over', () => {
        const v = keySink();
        deadThen(v, 'Space', ' ');
        v.handleKeyPress(ev('Space', '~'));
        v.handleKeyUp(ev('Space', ' '));
        v.sent.length = 0;

        const e = ev('KeyE', 'e');
        let prevented = false;
        e.preventDefault = () => (prevented = true);
        v.handleKeyDown(e);
        expect(prevented).toBe(true);
        expect(v.sent).toHaveLength(1);
    });

    it('waits through the Shift of a capital: dead key, Shift, then the letter', () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit2', 'Dead', altGr));
        v.handleKeyDown(ev('ShiftLeft', 'Shift', { shiftKey: true }));
        v.handleKeyDown(ev('KeyN', 'N', { shiftKey: true }));
        v.handleKeyPress(ev('KeyN', 'Ñ'));
        v.handleKeyUp(ev('KeyN', 'N', { shiftKey: true }));
        const n = v.sent.find((m) => m.type === 'keydown' && m.code === 'KeyN');
        expect(n.char).toBe('Ñ');
    });
});

describe('an AltGr dead key that Chrome does not name', () => {
    // Recorded on Windows Chrome, AZERTY (12/10/2026): AltGr+2 reads 'é', the
    // key's plain character, with AltGraph set and neither Ctrl nor Alt; the
    // tilde comes with the Space, which reads '~'. 'Dead' only ever came for
    // the ^ key, which needs no AltGr. One tilde typed "é~" on the native host.
    const azerty = new Map([
        ['Digit2', 'é'],
        ['Digit3', '"'],
        ['Digit7', 'è'],
        ['KeyT', 't'],
    ]);
    const altGr = { getModifierState: (n) => n === 'AltGraph' };

    it('flags AltGr+2 as dead, without its plain é, and sends the ~ on the Space', () => {
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('ControlLeft', 'Control', { ctrlKey: true }));
        v.handleKeyDown(ev('AltRight', 'AltGraph', altGr));
        v.handleKeyDown(ev('Digit2', 'é', altGr));
        v.handleKeyUp(ev('Digit2', 'é', altGr));
        v.handleKeyUp(ev('ControlLeft', 'Control', altGr));
        v.handleKeyUp(ev('AltRight', 'AltGraph'));
        v.handleKeyDown(ev('Space', '~'));
        v.handleKeyPress(ev('Space', '~'));
        v.handleKeyUp(ev('Space', ' '));

        const digit2 = v.sent.find((m) => m.type === 'keydown' && m.code === 'Digit2');
        expect(digit2).toMatchObject({ dead: true, char: null, nonUs: false });
        const space = v.sent.find((m) => m.type === 'keydown' && m.code === 'Space');
        expect(space).toMatchObject({ char: '~', dead: false });
    });

    it('keeps a real AltGr character: # on AltGr+3', () => {
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('Digit3', '#', altGr));
        expect(v.sent[0]).toMatchObject({ code: 'Digit3', char: '#', dead: false });
    });

    it('keeps a left Ctrl+Alt shortcut a shortcut', () => {
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('KeyT', 't', { ctrlKey: true, altKey: true }));
        expect(v.sent[0]).toMatchObject({ code: 'KeyT', char: 't', dead: false });
    });

    it('changes nothing without a layout map to tell', () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit2', 'é', altGr));
        expect(v.sent[0]).toMatchObject({ code: 'Digit2', char: 'é', dead: false });
    });
});
