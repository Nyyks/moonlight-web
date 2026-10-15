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
 * What the page says over a stream when its line to the machine is away.
 *
 * Through the rendezvous, menus, settings and the end of a session ride a line
 * of their own, beside the stream. When it drops the stream carries on, and
 * lineKeeper.js dials the line again behind it. This is the one sign of that on
 * screen: a small pill at the top, nothing to click, gone when the line is back.
 * Not a toast — a toast fades on a timer, and this lasts exactly as long as what
 * it describes.
 */
import { t } from '../i18n/i18n.js';

/** @type {HTMLElement | null} */
let pill = null;

/** @param {'reconnecting' | 'out-of-reach' | null} state null takes it away */
export function showLineNotice(state) {
    if (!state) {
        pill?.remove();
        pill = null;
        return;
    }
    if (!pill) {
        pill = document.createElement('div');
        pill.className = 'line-notice';
        pill.setAttribute('role', 'status');
        document.body.appendChild(pill);
    }
    pill.textContent = t(
        state === 'reconnecting' ? 'stream.lineReconnecting' : 'stream.lineOutOfReach',
    );
}
