/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LineKeeper, hangUp, REDIAL_ATTEMPTS, REDIAL_BUDGET_MS } from '../js/net/lineKeeper.js';

/**
 * Through the rendezvous, a phone that put the browser aside for two seconds
 * came back to the loading screen: the line to the machine had dropped, and a
 * dropped line sent the page back through the entry page. The line is now
 * dialled again under the page, which stays as it was.
 */

/** A line as the bootstrap's transport makes one, minus the network. */
class FakeLine {
    /** @param {{connect?: 'ok' | 'fail' | 'hang'}} [opts] */
    constructor({ connect = 'ok' } = {}) {
        this.connected = false;
        /** @type {((why: string) => void) | null} */
        this.onclosed = null;
        this.closed = false;
        /** Requests wait for an answer instead of getting one at once. */
        this.hold = false;
        /** @type {{reject: (e: Error) => void}[]} */
        this.pending = [];
        this._connect = connect;
    }

    connect() {
        if (this._connect === 'ok') {
            this.connected = true;
            return Promise.resolve();
        }
        if (this._connect === 'fail')
            return Promise.reject(new Error('That machine is not online right now.'));
        return new Promise(() => {});
    }

    /** @param {string} url */
    fetch(url) {
        if (!this.connected)
            return Promise.reject(new Error('the connection to your machine is not open'));
        if (this.hold) return new Promise((_, reject) => this.pending.push({ reject }));
        return Promise.resolve({ via: this, url });
    }

    close() {
        this.onclosed = null;
        this.closed = true;
        this.connected = false;
        this._fail('closed');
    }

    /** The transport's teardown: requests in flight fail, then onclosed. */
    drop(why = 'the channel closed') {
        this.connected = false;
        this._fail(why);
        if (this.onclosed) this.onclosed(why);
    }

    /** @param {string} why */
    _fail(why) {
        for (const p of this.pending.splice(0)) p.reject(new Error(why));
    }
}

function fakeDoc() {
    const doc = /** @type {any} */ (new EventTarget());
    doc.visibilityState = 'visible';
    doc.show = () => {
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
    };
    doc.hide = () => {
        doc.visibilityState = 'hidden';
        doc.dispatchEvent(new Event('visibilitychange'));
    };
    return doc;
}

/** @param {{lines?: FakeLine[], streaming?: boolean}} [opts] */
function setup({ lines = [], streaming = false } = {}) {
    const doc = fakeDoc();
    const queue = [...lines];
    const dial = vi.fn(() => queue.shift() ?? new FakeLine());
    const giveUp = vi.fn();
    const keeper = new LineKeeper({ dial, giveUp, streaming: () => streaming, doc });
    const first = new FakeLine();
    first.connected = true;
    keeper.adopt(first);
    return { doc, dial, giveUp, keeper, first };
}

describe('LineKeeper', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('dials a dropped line again in place, and requests go out on the new one', async () => {
        const next = new FakeLine();
        const { keeper, first, dial, giveUp } = setup({ lines: [next] });

        first.drop();
        const answer = await keeper.fetch('/api/hosts');

        expect(answer.via).toBe(next);
        expect(keeper.line).toBe(next);
        expect(dial).toHaveBeenCalledTimes(1);
        expect(giveUp).not.toHaveBeenCalled();
        // What was left of the old line is put down, so the machine stops
        // counting it.
        expect(first.closed).toBe(true);
    });

    it('dials nothing while the page is hidden, and dials as soon as it is back', async () => {
        const next = new FakeLine();
        const { keeper, first, dial, doc } = setup({ lines: [next] });

        doc.hide();
        first.drop();
        const asked = keeper.fetch('/api/hosts');
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(dial).not.toHaveBeenCalled();

        doc.show();
        expect((await asked).via).toBe(next);
    });

    it('keeps the entry page as the answer while a stream depends on the line', () => {
        const { first, dial, giveUp } = setup({ streaming: true });

        first.drop();

        expect(giveUp).toHaveBeenCalledTimes(1);
        expect(dial).not.toHaveBeenCalled();
    });

    it(`goes back through the entry page after ${REDIAL_ATTEMPTS} failed attempts`, async () => {
        const lines = Array.from({ length: 5 }, () => new FakeLine({ connect: 'fail' }));
        const { first, dial, giveUp } = setup({ lines });

        first.drop();
        await vi.advanceTimersByTimeAsync(REDIAL_BUDGET_MS);

        expect(dial).toHaveBeenCalledTimes(REDIAL_ATTEMPTS);
        expect(giveUp).toHaveBeenCalledTimes(1);
        expect(lines.slice(0, REDIAL_ATTEMPTS).every((l) => l.closed)).toBe(true);
    });

    it('goes back through the entry page when no line comes within the budget', async () => {
        const slow = new FakeLine({ connect: 'hang' });
        const { first, dial, giveUp } = setup({ lines: [slow] });

        first.drop();
        await vi.advanceTimersByTimeAsync(REDIAL_BUDGET_MS - 1);
        expect(giveUp).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(giveUp).toHaveBeenCalledTimes(1);
        expect(dial).toHaveBeenCalledTimes(1);
        expect(slow.closed).toBe(true);
    });

    it('drops an attempt the page hid in the middle of, and starts over on its return', async () => {
        const half = new FakeLine({ connect: 'hang' });
        const next = new FakeLine();
        const { keeper, first, dial, giveUp, doc } = setup({ lines: [half, next] });

        first.drop();
        expect(dial).toHaveBeenCalledTimes(1);
        doc.hide();
        await vi.advanceTimersByTimeAsync(0);
        expect(half.closed).toBe(true);

        // A long absence spends neither an attempt nor the budget.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(dial).toHaveBeenCalledTimes(1);
        expect(giveUp).not.toHaveBeenCalled();

        doc.show();
        await vi.advanceTimersByTimeAsync(0);
        expect(dial).toHaveBeenCalledTimes(2);
        expect(keeper.line).toBe(next);
    });

    it('asks a read again on the new line when the line goes down under it, not a write', async () => {
        const next = new FakeLine();
        const { keeper, first } = setup({ lines: [next] });
        first.hold = true;

        const read = keeper.fetch('/api/hosts');
        const write = keeper.fetch('/api/start', { method: 'POST' });
        await vi.advanceTimersByTimeAsync(0);
        first.drop('the channel closed');

        expect((await read).via).toBe(next);
        await expect(write).rejects.toThrow('the channel closed');
    });

    it('reports a failed request as it is when the line is fine', async () => {
        const { keeper, first, dial } = setup();
        first.fetch = () => Promise.reject(new Error('the host did not answer'));

        await expect(keeper.fetch('/api/hosts')).rejects.toThrow('the host did not answer');
        expect(dial).not.toHaveBeenCalled();
    });

    it('dials again on return when the line died without a word', () => {
        const { first, dial, doc } = setup({ lines: [new FakeLine()] });

        doc.hide();
        first.connected = false; // its close still queued behind the return
        doc.show();

        expect(dial).toHaveBeenCalledTimes(1);
    });

    it('ignores a close from a line it no longer uses', async () => {
        const next = new FakeLine();
        const { keeper, first, dial } = setup({ lines: [next] });

        first.drop();
        await keeper.ready();
        keeper.lost(first, 'late news');

        expect(dial).toHaveBeenCalledTimes(1);
        expect(keeper.line).toBe(next);
    });
});

describe('hangUp', () => {
    it('puts down a line from a transport that has no close()', () => {
        const line = {
            onclosed: () => {},
            _dc: { close: vi.fn() },
            _pc: {
                close: vi.fn(() => {
                    throw new Error('already gone');
                }),
            },
            _ws: null,
        };

        hangUp(line);

        expect(line.onclosed).toBeNull();
        expect(line._dc.close).toHaveBeenCalled();
        expect(line._pc.close).toHaveBeenCalled();
    });
});
