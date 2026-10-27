/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * A file of the application the browser refuses to cache: the entry page's
 * failure names it and the storage error, where the browser's own message named
 * neither (26/10, "Entry already exists." for the whole interface).
 */

import { describe, it, expect } from 'vitest';
import { storeShellFile } from '../../bootstrap/v1/tunnel.js';

/** A cache whose put does what @p put says; records what it was handed. */
function fakeCache(put) {
    const calls = [];
    return {
        calls,
        put: async (path, response) => {
            calls.push([path, response]);
            return put();
        },
    };
}

describe('storeShellFile', () => {
    it('puts the response under its path', async () => {
        const cache = fakeCache(() => undefined);
        const response = { ok: true };
        await storeShellFile(cache, '/js/app.js', response);
        expect(cache.calls).toEqual([['/js/app.js', response]]);
    });

    it('names the file and the storage error when the browser refuses', async () => {
        const refused = new Error("Failed to execute 'put' on 'Cache': Entry already exists.");
        refused.name = 'InvalidStateError';
        const cache = fakeCache(() => Promise.reject(refused));
        await expect(storeShellFile(cache, '/js/ui/StreamView.js', {})).rejects.toThrow(
            "the browser could not store /js/ui/StreamView.js (InvalidStateError: Failed to execute 'put' on 'Cache': Entry already exists.)",
        );
    });

    it('still names the file when what was thrown is not an Error', async () => {
        const cache = fakeCache(() => Promise.reject('quota'));
        await expect(storeShellFile(cache, '/css/base.css', {})).rejects.toThrow(
            'the browser could not store /css/base.css (quota)',
        );
    });

    it('tries once, and only once', async () => {
        const cache = fakeCache(() => Promise.reject(new Error('no')));
        await expect(storeShellFile(cache, '/index.html', {})).rejects.toThrow();
        expect(cache.calls).toHaveLength(1);
    });
});
