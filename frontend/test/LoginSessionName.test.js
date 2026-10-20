/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * The PIN page's two small promises: the session name typed once comes back
 * the next time this browser has to unlock (the host lists the device by it),
 * and the caret never leaves the slot right after the last digit typed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getAuthStatus: vi.fn(),
        validatePin: vi.fn(async () => ({ status: 'ok' })),
        validateCertificate: vi.fn(async () => ({ status: 'ok' })),
    },
}));
vi.mock('../js/ui/Toast.js', () => ({
    Toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('../js/i18n/i18n.js', () => ({
    t: (key) => key,
}));
vi.mock('../js/net/tunnelBridge.js', () => ({
    tunnelHostId: () => null,
}));

import { LoginView } from '../js/ui/LoginView.js';
import { BackendClient } from '../js/api/BackendClient.js';

describe('LoginView session name and PIN caret', () => {
    let view;

    const open = async () => {
        document.body.innerHTML = '<div id="host"></div>';
        view = new LoginView(document.getElementById('host'), () => {});
        await view.start();
    };
    const nameInput = () =>
        /** @type {HTMLInputElement} */ (document.getElementById('login-machine-input'));
    const pinInput = () =>
        /** @type {HTMLInputElement} */ (document.getElementById('login-pin-input'));
    const type = (el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input'));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        BackendClient.getAuthStatus.mockResolvedValue({ authenticated: false, remaining: 3 });
    });
    afterEach(() => view && view.destroy());

    it('offers the name signed in under last time', async () => {
        await open();
        expect(nameInput().value).toBe(LoginView.suggestedMachineName());

        type(nameInput(), 'Living-room tablet');
        type(pinInput(), '123456');
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() => expect(BackendClient.validatePin).toHaveBeenCalled());
        await Promise.resolve();
        view.destroy();

        await open();
        expect(nameInput().value).toBe('Living-room tablet');
    });

    it('keeps following the browser when the suggestion was left as it was', async () => {
        localStorage.setItem('mw-session-name', 'Old name');
        await open();
        type(nameInput(), LoginView.suggestedMachineName());
        type(pinInput(), '123456');
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() => expect(BackendClient.validatePin).toHaveBeenCalled());
        await Promise.resolve();
        expect(localStorage.getItem('mw-session-name')).toBeNull();
    });

    it('keeps the typed name through a wrong PIN', async () => {
        BackendClient.validatePin.mockRejectedValueOnce(
            Object.assign(new Error('nope'), { statusCode: 401, responseBody: { remaining: 2 } }),
        );
        await open();
        type(nameInput(), 'Phone');
        type(pinInput(), '111111');
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() =>
            expect(document.getElementById('login-error').textContent).not.toBe(''),
        );
        expect(nameInput().value).toBe('Phone');
        expect(localStorage.getItem('mw-session-name')).toBeNull();
    });

    it('puts the caret back right after the last digit', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '34');
        expect(pin.value).toBe('34- ---');

        pin.setSelectionRange(1, 1); // "3|4"
        document.dispatchEvent(new Event('selectionchange'));
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([2, 2]);

        pin.setSelectionRange(6, 6); // among the dashes
        pin.dispatchEvent(new Event('click'));
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([2, 2]);
    });

    it('leaves a long-press selection alone, so the Paste menu stays', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '3456');
        pin.setSelectionRange(0, 7);
        document.dispatchEvent(new Event('selectionchange'));
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([0, 7]);
    });

    it('reads a pasted PIN whole, wherever the caret was', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '34');
        const paste = (text) => {
            const e = new Event('paste', { cancelable: true });
            Object.defineProperty(e, 'clipboardData', { value: { getData: () => text } });
            pin.dispatchEvent(e);
            return e;
        };
        expect(paste('702 502').defaultPrevented).toBe(true);
        expect(pin.value).toBe('702 502');

        type(pin, '12');
        paste('34');
        expect(pin.value).toBe('123 4--');
    });

    it('swallows the keys that walk the caret', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
        pin.dispatchEvent(left);
        expect(left.defaultPrevented).toBe(true);
    });
});
