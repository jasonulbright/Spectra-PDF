// Re-blit batching (the probe-classified flicker fix, 18-phase3-polish.md):
// buffer-swap re-renders complete staggered over hundreds of ms; the
// scheduler must hold them through a quiet window, flush them TOGETHER in
// arrival order, cap the hold under a continuous trickle, and batch anew
// after each flush.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REBLIT_MAX_HOLD_MS,
  REBLIT_QUIET_MS,
  scheduleReblit,
} from '../src/renderer/components/canvas/raster';

beforeEach(() => {
  vi.useFakeTimers();
  // node has no requestAnimationFrame — run flush callbacks on the next
  // fake-timer tick instead.
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    setTimeout(() => cb(0), 0);
    return 0;
  });
});

afterEach(() => {
  // Drain anything a test left queued so module state can't leak across.
  vi.advanceTimersByTime(REBLIT_MAX_HOLD_MS * 2);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('scheduleReblit', () => {
  it('holds staggered completions and flushes them together in order', () => {
    const landed: string[] = [];
    scheduleReblit(() => landed.push('a'));
    vi.advanceTimersByTime(REBLIT_QUIET_MS - 20);
    scheduleReblit(() => landed.push('b')); // arrival resets the quiet window
    vi.advanceTimersByTime(REBLIT_QUIET_MS - 20);
    scheduleReblit(() => landed.push('c'));
    expect(landed).toEqual([]); // nothing lands while arrivals keep coming
    vi.advanceTimersByTime(REBLIT_QUIET_MS + 1);
    expect(landed).toEqual(['a', 'b', 'c']); // one flush, arrival order
  });

  it('caps the hold under a continuous trickle of arrivals', () => {
    const landed: number[] = [];
    scheduleReblit(() => landed.push(0));
    // Arrivals every 100ms stay inside the 120ms quiet window forever —
    // only the max-hold cap can flush this batch.
    let t = 0;
    while (landed.length === 0 && t <= REBLIT_MAX_HOLD_MS + 200) {
      vi.advanceTimersByTime(100);
      t += 100;
      const stamp = t;
      scheduleReblit(() => landed.push(stamp));
    }
    expect(landed.length).toBeGreaterThan(0); // the cap fired mid-trickle
    expect(landed[0]).toBe(0); // arrival order preserved
    expect(t).toBeLessThanOrEqual(REBLIT_MAX_HOLD_MS + 200); // not the quiet path
  });

  it('flushes synchronously when an arrival lands past the cap (stalled timers)', () => {
    // Review round 3: the cap can fire two ways — the remaining-capped
    // timer, or the synchronous heldFor check when an arrival lands after
    // wall time passed the cap without timers running (a main-thread
    // stall). This pins the synchronous branch; test 2 pins the timer one.
    const landed: string[] = [];
    scheduleReblit(() => landed.push('early'));
    vi.setSystemTime(Date.now() + REBLIT_MAX_HOLD_MS + 100); // stall: clock moves, no timer fires
    scheduleReblit(() => landed.push('late'));
    expect(landed).toEqual([]); // flushed into one rAF, not painted inline
    vi.advanceTimersByTime(1); // run the stubbed rAF
    expect(landed).toEqual(['early', 'late']);
  });

  it('starts a fresh batch after a flush', () => {
    const landed: string[] = [];
    scheduleReblit(() => landed.push('first'));
    vi.advanceTimersByTime(REBLIT_QUIET_MS + 1);
    expect(landed).toEqual(['first']);
    scheduleReblit(() => landed.push('second'));
    expect(landed).toEqual(['first']); // the new batch holds again
    vi.advanceTimersByTime(REBLIT_QUIET_MS + 1);
    expect(landed).toEqual(['first', 'second']);
  });
});
