/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * CrashRelaunch — whether a stream whose link went is started again.
 *
 * The stream's WebRTC connection lives in the host's --stream-worker, so when
 * that process dies the page only sees its link go, a few seconds later. The
 * host remembers how each stream ended (StreamEnds.h) and the page asks:
 *
 *   crashed   the worker died under a healthy stream: start it again, with the
 *             transport that worked, behind the "Reconnecting…" veil
 *   anything  live (a network cut, seen from here first), ended (the app closed,
 *   else      the link died host-side), stopped (Stop, another device took the
 *             stream over), unknown (no answer in time): the stream ends as
 *             it always has
 *
 * Twice at most in five minutes: a worker that crashes again and again is not
 * started a third time, and the viewer gets the screen they always got. A
 * launch the viewer makes themselves starts the count again.
 */

export const CRASH_RELAUNCH_MAX = 2;
export const CRASH_RELAUNCH_WINDOW_MS = 5 * 60 * 1000;
/** How long the page waits for the host's answer before ending as before. */
export const STREAM_STATE_TIMEOUT_MS = 1500;

/**
 * @param {string} state what the host says of the lost stream
 * @param {number[]} history when the previous relaunches happened (ms)
 * @param {number} now
 * @returns {boolean}
 */
export function shouldRelaunchAfterCrash(state, history, now) {
    if (state !== 'crashed') return false;
    return recentRelaunches(history, now).length < CRASH_RELAUNCH_MAX;
}

/**
 * The history with this relaunch in it, and without what has aged out.
 * @param {number[]} history
 * @param {number} now
 * @returns {number[]}
 */
export function recordCrashRelaunch(history, now) {
    return [...recentRelaunches(history, now), now];
}

/**
 * @param {number[]} history
 * @param {number} now
 * @returns {number[]}
 */
function recentRelaunches(history, now) {
    return (history || []).filter((at) => now - at < CRASH_RELAUNCH_WINDOW_MS);
}
