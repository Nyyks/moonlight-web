/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * The enhancer and decode-rate governors ride the 500 ms tick, not the stats
 * card's repaint: with the card hidden or closed, _updateOverlay returns
 * before its body, and both ladders used to stop there for the session.
 */
const P = StreamView.prototype;

const DIAG = { arrivalAvgMs: 1000 / 60, decodeQueueAvg: 3, renderServiceMs: 2 };

function view(over = {}) {
    return {
        _transport: 'webrtc',
        _firstFrameRendered: true,
        _useWorker: false,
        _workerDiag: null,
        _diag: { snapshot: () => DIAG },
        _fpsTimestamps: [],
        _applyEnhancerGovernor: vi.fn(),
        _applyDecodeRateGovernor: vi.fn(),
        _decodedFps: P._decodedFps,
        _runPipelineGovernors: P._runPipelineGovernors,
        ...over,
    };
}

describe('StreamView — the governors on the tick', () => {
    it('feeds both governors with the card hidden or closed', () => {
        for (const card of [{ _showPerfStats: false }, { _statsClosed: true }]) {
            const v = view(card);
            v._fpsTimestamps = Array.from({ length: 120 }, (_, i) => 9000 + i * 8);
            v._runPipelineGovernors(10000);
            expect(v._applyEnhancerGovernor).toHaveBeenCalledWith(DIAG, 10000);
            expect(v._applyDecodeRateGovernor).toHaveBeenCalledWith(DIAG, 60, 10000);
        }
    });

    it('leaves the enhancer to the worker, and reads its posted counters', () => {
        const posted = { ...DIAG, decodeQueueAvg: 5 };
        const v = view({ _useWorker: true, _workerDiag: posted });
        v._runPipelineGovernors(10000);
        expect(v._applyEnhancerGovernor).not.toHaveBeenCalled();
        expect(v._applyDecodeRateGovernor).toHaveBeenCalledWith(posted, 0, 10000);
    });

    it('waits for the first frame, and skips webrtc-media', () => {
        for (const over of [{ _firstFrameRendered: false }, { _transport: 'webrtc-media' }]) {
            const v = view(over);
            v._runPipelineGovernors(10000);
            expect(v._applyEnhancerGovernor).not.toHaveBeenCalled();
            expect(v._applyDecodeRateGovernor).not.toHaveBeenCalled();
        }
    });

    it('prunes the decoded-frame window every tick, card or not', () => {
        const v = view({ _firstFrameRendered: false });
        v._fpsTimestamps = Array.from({ length: 600 }, (_, i) => i * 16);
        v._runPipelineGovernors(20000);
        expect(v._fpsTimestamps).toEqual([]);
    });
});
