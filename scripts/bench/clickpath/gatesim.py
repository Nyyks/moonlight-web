"""The stream's gate replayed on a pass's captures (plan « attente », 09/10/2026).

The native host encodes only the presents its gate admits
(backend/native-host/src/core/FrameCadence.h): the first present in each
tick's window of the stream's grid, from a quarter of an interval before the
tick to a quarter before the next. A window with nothing in it moves the grid
to the present that ends the gap; two, and the grid restarts on it.
This replays that gate, offline, on the captures a pass recorded, at any
stream rate and display rate, and says what the stream would have carried.

⚠️ Gate below is a COPY of FrameCadence::admit() (and of ceiling(), for a
stream at or above the display's rate): the nanosecond grid, kSlackDivisor 4,
kCeilingHeadroom 50, the windows, a ceiling's re-anchor past one display
period. Change it with the class. --before is the gate of the passes of 08-09/10
(re-anchored on any present later than one display period); checked on
09/10/2026, on every pass of benches 2 and c1 it gives the host's own "N not
carried" count to within 2 (7731 for 7733).

What it needs: a pass run with clicktrace=1 in MW_NATIVE_TUNING, whose capture
wake-ups were copied as bench-out/content-age/<tag>.click-trace.csv (see the
README). Traces of 08-09/10/2026 there:
  *-re9-vis-*      RE9 alone, ~77 pictures a second, virtual display at 120
                   and 240 Hz (<tag>.re9.txt bounds the game's scene)
  *-aw21-*         mw-click-target at 240 fps, virtual display at 120 / 240 Hz
  *-aw2c-*, *-aw2s-*  the same at 240 Hz, the stream at 120 or 240 fps

    python gatesim.py <tag> [<tag>...] [--fps 60] [--hz 240] [--before | --advance]

--fps / --hz: the stream's rate and the display's (default: both from the
pass's log). --before: the gate until the fix of 09/10/2026 (Cadence session),
for a pass recorded with it. --advance: the change the Android TV bench
proposed (B, 08/10/2026), a present later than one display period moving the
grid on by whole intervals from the tick it missed; it gives the rate back but
lets a game at the stream's rate beat against the grid. Per pass: the new pictures,
those the gate skipped, how long a skipped picture's change waited for the
next admitted one, and that wait averaged over every instant (what a click at
a random moment pays for the gate).

--inputadmit T[,B,R,S,K] (plan « inputadmit », 13/10/2026): the admission
window after a press on top of the gate, replayed on the pass's own presses
(the trace's `press` rows). T in ms, B windows ahead, R windows a second, S the
least gap in ms between two admitted pictures, K the most pictures a window
adds (0: as many presents as the display makes in T); B, R, S and K default to
3, 2, 0 and 3, the host's own defaults.
Its class, InputAdmit, is a COPY of core/InputAdmit.h, like Gate's. The
variants and what they cost the client: inputsim.py.
"""
import argparse
import csv
import os
import re

OUT = os.path.join("bench-out", "content-age")


class Gate:
    """FrameCadence::admit(); rule "before" or "advance" for the older ones."""

    SLACK_DIVISOR = 4
    CEILING_HEADROOM = 50

    def __init__(self, fps, display_hz, rule="now"):
        self.interval_ns = (1000000 // fps) * 1000
        self.ceiling = fps >= display_hz
        if self.ceiling:
            self.interval_ns = self.interval_ns * self.CEILING_HEADROOM // (self.CEILING_HEADROOM + 1)
        self.reanchor_ns = (1000000 // display_hz) * 1000
        interval_us = self.interval_ns // 1000
        self.slack_us = interval_us if self.ceiling else interval_us // self.SLACK_DIVISOR
        self.next_due_ns = 0
        self.rule = rule

    def admit(self, now_us):
        now_ns = now_us * 1000
        slack_ns = self.slack_us * 1000
        if now_ns + slack_ns < self.next_due_ns:
            return False
        late_ns = now_ns - self.next_due_ns
        if self.ceiling or self.rule != "now":
            if late_ns <= self.reanchor_ns:
                self.next_due_ns += self.interval_ns
            elif self.rule == "advance" and not self.ceiling and self.next_due_ns:
                self.next_due_ns += (late_ns // self.interval_ns + 1) * self.interval_ns
            else:
                self.next_due_ns = now_ns + self.interval_ns
            return True
        window_end_ns = self.interval_ns - slack_ns
        if late_ns < window_end_ns:
            self.next_due_ns += self.interval_ns
        elif late_ns < window_end_ns + self.interval_ns:
            self.next_due_ns = now_ns + slack_ns
        else:
            self.next_due_ns = now_ns + self.interval_ns
        return True


class InputAdmit:
    """core/InputAdmit.h: for T after a press, every present goes through, on
    top of the gate, whose grid keeps its phase (it is asked first, on every
    present, and never learns of these pictures).

    ⚠️ A COPY of InputAdmit, as Gate is of FrameCadence: change both together.
    - A window opens on a press for one token of a bucket of windows (B ahead,
      R more a second): a window opens whole or not at all. A press inside an
      open window carries it on to T after itself, for no token.
    - It admits the presents made from the press to T after it (their present,
      not their wake-up: a picture composed before the press cannot carry it),
      at most `max_extra` beyond the grid's, each S at least after the last
      picture admitted, grid or window.
    - Presses between two of the loop's calls are taken together: the window
      from the first to T after the last. Presses the loop takes only once
      their window is over open nothing.
    - The caller's guards: the link's word, and the encoder's.
    """

    def __init__(self, window_us, burst=3, rate=2.0, gap_us=0, interval_us=16666, display_hz=240,
                 max_extra=0):
        # At least one interval of the stream: a shorter window can end
        # before the grid's next picture would have come anyway.
        self.window_us = max(int(window_us), int(interval_us))
        self.burst = burst
        self.rate = rate
        self.gap_us = int(gap_us)
        # By default the presents a window can hold at the display's rate: a
        # source that presents faster than its display refreshes gets no more.
        self.max_extra = max_extra or max(1, round(self.window_us * display_hz / 1e6))
        self.tokens = float(burst)
        self.refilled_us = None
        self.first_us = self.last_press_us = None
        self.start_us = self.end_us = None
        self.extra = 0
        self.last_us = None
        self.presses = self.windows = self.carried = self.refused = self.late = 0
        self.frames = self.capped = self.gapped = self.link_refused = self.encoder_refused = 0
        # Each group of presses taken: (first, last, "open" | "carried" | "refused"),
        # for inputsim.py.
        self.outcomes = []

    def note_press(self, now_us):
        """The input thread: a press, kept until the loop takes it."""
        self.presses += 1
        if self.first_us is None:
            self.first_us = now_us
        self.last_press_us = now_us

    def _take_press(self, now_us):
        first_us, last_us = self.first_us, self.last_press_us
        self.first_us = self.last_press_us = None
        if last_us + self.window_us <= now_us:
            self.late += 1
            self.outcomes.append((first_us, last_us, "late"))
            return
        if self.refilled_us is not None:
            self.tokens = min(self.burst, self.tokens + (first_us - self.refilled_us) * self.rate / 1e6)
        self.refilled_us = first_us
        if self.end_us is not None and first_us < self.end_us:
            self.end_us = last_us + self.window_us
            self.carried += 1
            self.outcomes.append((first_us, last_us, "carried"))
        elif self.tokens >= 1:
            self.tokens -= 1
            self.start_us, self.end_us, self.extra = first_us, last_us + self.window_us, 0
            self.windows += 1
            self.outcomes.append((first_us, last_us, "open"))
        else:
            self.refused += 1
            self.outcomes.append((first_us, last_us, "refused"))

    def admit(self, grid_said, present_us, now_us, link_ok=True, encoder_ok=True):
        """@p grid_said: the gate's answer for this present. True: encode it."""
        if self.first_us is not None:
            self._take_press(now_us)
        if grid_said:
            self.last_us = now_us
            return True
        if self.end_us is None or not self.start_us <= present_us < self.end_us:
            return False
        if self.extra >= self.max_extra:
            self.capped += 1
            return False
        if self.gap_us and self.last_us is not None and now_us - self.last_us < self.gap_us:
            self.gapped += 1
            return False
        if not encoder_ok:
            self.encoder_refused += 1
            return False
        if not link_ok:
            self.link_refused += 1
            return False
        self.extra += 1
        self.frames += 1
        self.last_us = now_us
        return True


def parse_inputadmit(text):
    """'T[,B,R,S,K]' (ms, windows, windows a second, ms, pictures) → keyword
    arguments of InputAdmit."""
    parts = [float(v) for v in text.split(",")]
    parts += [3, 2.0, 0, 3][len(parts) - 1:]
    t_ms, burst, rate, gap_ms, most = parts[:5]
    return {"window_us": t_ms * 1000, "burst": int(burst), "rate": rate, "gap_us": gap_ms * 1000,
            "max_extra": int(most)}


def pass_rates(base):
    """The stream's and the display's rates the pass ran at, from its log."""
    try:
        with open(base + ".server.log", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.search(r"cadence: (\d+)(?:\.\d+)? Hz display, (\d+) fps stream", line)
                if m:
                    return int(m.group(2)), int(m.group(1))
    except OSError:
        pass
    return None, None


def scene(base):
    """A game pass's scene, on the host's clock (µs), or None for the whole pass."""
    try:
        text = open(base + ".re9.txt", encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    lo = re.search(r"steady=(\d+) scene from here", text)
    hi = re.search(r"steady=(\d+) scene to here", text)
    return (int(lo.group(1)), int(hi.group(1))) if lo and hi else None


def q(xs, p):
    xs = sorted(xs)
    return xs[int(p * (len(xs) - 1))] if xs else float("nan")


def one(tag, a):
    base = os.path.join(a.dir, tag)
    rows = list(csv.DictReader(open(base + ".click-trace.csv")))
    caps = [(int(r["us"]), int(r["presentUs"])) for r in rows
            if r["kind"] == "capture" and r["status"] == "ok"]
    presses = sorted(int(r["startUs"]) for r in rows if r["kind"] == "press")
    if not caps:
        print("%s: no captures" % tag)
        return
    fps, hz = pass_rates(base)
    fps, hz = a.fps or fps, a.hz or hz
    if not fps or not hz:
        print("%s: no rates in the log, give --fps and --hz" % tag)
        return
    gate = Gate(fps, hz, a.rule)
    window = None
    if a.inputadmit and not gate.ceiling:
        window = InputAdmit(interval_us=gate.interval_ns // 1000, display_hz=hz,
                            **parse_inputadmit(a.inputadmit))
    # The gate runs over the whole pass, as the host's did; only the scene counts.
    admitted, pi = [], 0
    for t, present in caps:
        ok = gate.admit(t)
        if window:
            # The presses handed to the OS before this wake-up.
            while pi < len(presses) and presses[pi] <= t:
                window.note_press(presses[pi])
                pi += 1
            ok = window.admit(ok, present, t)
        admitted.append((t, ok))
    caps = [t for t, _ in caps]
    lo, hi = scene(base) or (caps[0], caps[-1])
    kept = [(t, ok) for t, ok in admitted if lo <= t <= hi]
    span = (hi - lo) / 1e6
    skipped_waits, weighted, total, next_ok = [], 0.0, 0.0, None
    # Backwards: for each new picture, the first admitted one at or after it.
    for i in range(len(kept) - 1, -1, -1):
        t, ok = kept[i]
        if ok:
            next_ok = t
        if next_ok is None:
            continue
        wait = next_ok - t
        if not ok:
            skipped_waits.append(wait / 1000)
        if i > 0:
            # Every instant since the picture before sees this one first.
            seg = t - kept[i - 1][0]
            weighted += seg * wait
            total += seg
    skipped = sum(1 for _, ok in kept if not ok)
    print("%s: %d fps stream, %d Hz display%s: %.1f new pictures/s, %.1f carried/s, %d skipped (%.1f %%), "
          "a skipped one waits p50 %.1f p90 %.1f ms, mean cost %.2f ms" % (
              tag, fps, hz, "" if a.rule == "now" else ", --" + a.rule,
              len(kept) / span, (len(kept) - skipped) / span, skipped, 100 * skipped / len(kept),
              q(skipped_waits, .5), q(skipped_waits, .9), weighted / total / 1000 if total else 0))
    if window:
        print("  input admit %s: %d presses, %d windows (%d carried on by a press, %d refused by the "
              "bucket), %d pictures more (%.2f a press, %.2f/s), %d held back by the cap, %d by the gap" % (
                  a.inputadmit, window.presses, window.windows, window.carried, window.refused,
                  window.frames, window.frames / max(1, window.presses),
                  window.frames * 1e6 / (caps[-1] - caps[0]), window.capped, window.gapped))
    elif a.inputadmit:
        print("  input admit: none under a ceiling (a stream at the display's rate)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("tags", nargs="+")
    ap.add_argument("--dir", default=OUT)
    ap.add_argument("--fps", type=int, default=0, help="the stream's rate (default: the pass's)")
    ap.add_argument("--hz", type=int, default=0, help="the display's rate (default: the pass's)")
    rule = ap.add_mutually_exclusive_group()
    rule.add_argument("--before", dest="rule", action="store_const", const="before",
                      help="the gate until 09/10/2026: re-anchored on a present later than a display period")
    rule.add_argument("--advance", dest="rule", action="store_const", const="advance",
                      help="a late present moves the grid on by whole intervals (Android TV bench, 08/10)")
    ap.set_defaults(rule="now")
    ap.add_argument("--inputadmit", metavar="T[,B,R,S,K]",
                    help="the admission window after a press, on the pass's presses (ms, windows, "
                         "windows a second, ms, pictures)")
    a = ap.parse_args()
    for tag in a.tags:
        one(tag, a)


if __name__ == "__main__":
    main()
