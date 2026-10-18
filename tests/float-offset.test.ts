import { describe, expect, it } from 'vitest';
import {
  FLOAT_KEY_STEP,
  FLOAT_KEY_STEP_LARGE,
  clampFloatOffset,
  dragFloatOffset,
  floatTranslation,
  keyFloatOffset,
  measureFloatBounds,
  drawnFloatOffset,
  sameFloatBounds,
  type FloatBounds,
} from '../src/renderer/lib/float-offset';

// A 1000 x 700 canvas view with a 40px tool strip and a 30px status bar. The
// bar is 400 x 40 in its default slot: 16px from the inline-end edge, 16px
// below the tool strip.
const BOUNDS: FloatBounds = {
  viewWidth: 1000,
  viewHeight: 700,
  insetStart: 40,
  insetEnd: 30,
  slotEnd: 16,
  slotTop: 56,
  barWidth: 400,
  barHeight: 40,
};

/** The bar's box in view coordinates for `rtl`, with `offset` applied. */
function placed(offset: { inline: number; block: number }, rtl: boolean, b = BOUNDS) {
  const slotLeft = rtl ? b.slotEnd : b.viewWidth - b.slotEnd - b.barWidth;
  const t = floatTranslation(offset, rtl);
  const left = slotLeft + t.x;
  const top = b.slotTop + t.y;
  return { left, right: left + b.barWidth, top, bottom: top + b.barHeight };
}

function inside(box: ReturnType<typeof placed>, b = BOUNDS): boolean {
  return box.left >= 0 && box.right <= b.viewWidth && box.top >= b.insetStart && box.bottom <= b.viewHeight - b.insetEnd;
}

describe('clampFloatOffset', () => {
  it('keeps an offset that already fits', () => {
    expect(clampFloatOffset({ inline: 100, block: 200 }, BOUNDS)).toEqual({ inline: 100, block: 200 });
    expect(clampFloatOffset({ inline: 0, block: 0 }, BOUNDS)).toEqual({ inline: 0, block: 0 });
  });

  it('stops the bar at every edge of the document region', () => {
    // Inline-end edge: the slot is 16px from it.
    expect(clampFloatOffset({ inline: -500, block: 0 }, BOUNDS).inline).toBe(-16);
    // Inline-start edge: 1000 - 400 - 16.
    expect(clampFloatOffset({ inline: 5000, block: 0 }, BOUNDS).inline).toBe(584);
    // Top: under the tool strip, never over it.
    expect(clampFloatOffset({ inline: 0, block: -500 }, BOUNDS).block).toBe(-16);
    // Bottom: above the status bar. 700 - 30 - 40 - 56.
    expect(clampFloatOffset({ inline: 0, block: 5000 }, BOUNDS).block).toBe(574);
  });

  it('a clamped bar is fully inside the region in both directions', () => {
    for (const rtl of [false, true]) {
      for (const inline of [-9999, -16, 0, 300, 584, 9999]) {
        for (const block of [-9999, -16, 0, 574, 9999]) {
          const box = placed(clampFloatOffset({ inline, block }, BOUNDS), rtl);
          expect(inside(box), `${rtl} ${inline} ${block}`).toBe(true);
        }
      }
    }
  });

  it('a resize that shrinks the region pulls a moved bar back inside', () => {
    const moved = { inline: 584, block: 574 };
    const smaller = { ...BOUNDS, viewWidth: 700, viewHeight: 400 };
    const next = clampFloatOffset(moved, smaller);
    expect(next).toEqual({ inline: 284, block: 274 });
    expect(inside(placed(next, false, smaller), smaller)).toBe(true);
    // The bar wraps onto a second row and grows: the bottom limit moves up.
    const taller = { ...BOUNDS, barHeight: 72 };
    expect(clampFloatOffset(moved, taller).block).toBe(542);
    // A tool strip that appears pushes the slot down by the same amount.
    const strip = { ...BOUNDS, insetStart: 80, slotTop: 96 };
    expect(clampFloatOffset({ inline: 0, block: -40 }, strip).block).toBe(-16);
  });

  it('a bar larger than the region keeps its inline-end edge and its top in view', () => {
    const tiny = { ...BOUNDS, viewWidth: 300, viewHeight: 90 };
    expect(clampFloatOffset({ inline: 50, block: 50 }, tiny)).toEqual({ inline: -16, block: -16 });
  });

  it('never returns negative zero', () => {
    const at = clampFloatOffset({ inline: -0, block: -0 }, BOUNDS);
    expect(Object.is(at.inline, -0)).toBe(false);
    expect(Object.is(at.block, -0)).toBe(false);
  });
});

describe('dragFloatOffset', () => {
  it('a pointer moved left carries the bar toward the inline start in LTR', () => {
    expect(dragFloatOffset({ inline: 0, block: 0 }, -120, 30, false)).toEqual({ inline: 120, block: 30 });
    expect(dragFloatOffset({ inline: 50, block: 10 }, 20, -5, false)).toEqual({ inline: 30, block: 5 });
  });

  it('flips the inline sign in RTL, where the inline start is on the right', () => {
    expect(dragFloatOffset({ inline: 0, block: 0 }, 120, 30, true)).toEqual({ inline: 120, block: 30 });
    expect(dragFloatOffset({ inline: 50, block: 10 }, -20, -5, true)).toEqual({ inline: 30, block: 5 });
  });

  it('the bar follows the pointer on screen in both directions', () => {
    for (const rtl of [false, true]) {
      const before = placed({ inline: 100, block: 100 }, rtl);
      const after = placed(dragFloatOffset({ inline: 100, block: 100 }, -37, 21, rtl), rtl);
      expect(after.left - before.left, String(rtl)).toBe(-37);
      expect(after.top - before.top, String(rtl)).toBe(21);
    }
  });
});

describe('floatTranslation', () => {
  it('maps the logical offset to screen pixels', () => {
    expect(floatTranslation({ inline: 30, block: 12 }, false)).toEqual({ x: -30, y: 12 });
    expect(floatTranslation({ inline: 30, block: 12 }, true)).toEqual({ x: 30, y: 12 });
    expect(floatTranslation({ inline: 0, block: 0 }, false)).toEqual({ x: 0, y: 0 });
  });
});

describe('keyFloatOffset', () => {
  it('arrow keys move the bar on screen; Shift takes the larger step', () => {
    for (const rtl of [false, true]) {
      const origin = { inline: 100, block: 100 };
      const base = placed(origin, rtl);
      const at = (key: string, large = false) => placed(keyFloatOffset(origin, key, large, rtl)!, rtl);
      expect(at('ArrowLeft').left - base.left).toBe(-FLOAT_KEY_STEP);
      expect(at('ArrowRight').left - base.left).toBe(FLOAT_KEY_STEP);
      expect(at('ArrowUp').top - base.top).toBe(-FLOAT_KEY_STEP);
      expect(at('ArrowDown').top - base.top).toBe(FLOAT_KEY_STEP);
      expect(at('ArrowLeft', true).left - base.left).toBe(-FLOAT_KEY_STEP_LARGE);
      expect(at('ArrowDown', true).top - base.top).toBe(FLOAT_KEY_STEP_LARGE);
    }
  });

  it('any other key is not a move', () => {
    for (const key of ['Home', 'End', 'Enter', 'a', 'Tab']) {
      expect(keyFloatOffset({ inline: 0, block: 0 }, key, false, false)).toBeNull();
    }
  });
});

describe('measureFloatBounds', () => {
  const view = { clientWidth: 1000, clientHeight: 700 };
  const insets = { start: 40, end: 30 };

  it('reads the slot from the inline-end edge in LTR', () => {
    const bar = { offsetLeft: 584, offsetTop: 56, offsetWidth: 400, offsetHeight: 40 };
    expect(measureFloatBounds(bar, view, insets, false)).toEqual(BOUNDS);
  });

  it('reads the slot from the left edge in RTL, where the slot is mirrored', () => {
    const bar = { offsetLeft: 16, offsetTop: 56, offsetWidth: 400, offsetHeight: 40 };
    expect(measureFloatBounds(bar, view, insets, true)).toEqual(BOUNDS);
  });
});

describe('drawnFloatOffset', () => {
  it('a bar parked at the edge returns there when a narrower canvas widens again', () => {
    // At the inline-start edge of the full canvas.
    const intended = clampFloatOffset({ inline: 9999, block: 100 }, BOUNDS);
    expect(intended).toEqual({ inline: 584, block: 100 });
    // A tool dock opens: the canvas narrows and the bar is drawn pulled in.
    const narrow = { ...BOUNDS, viewWidth: 700 };
    expect(drawnFloatOffset(intended, narrow)).toEqual({ inline: 284, block: 100 });
    expect(inside(placed(drawnFloatOffset(intended, narrow)!, false, narrow), narrow)).toBe(true);
    // The dock closes: the bar is drawn where the user put it.
    expect(drawnFloatOffset(intended, BOUNDS)).toEqual(intended);
    // Writing the clamp back as the choice would have lost the edge.
    expect(drawnFloatOffset(drawnFloatOffset(intended, narrow), BOUNDS)).toEqual({ inline: 284, block: 100 });
  });

  it('the slot stays the slot, and an unmeasured bar draws the choice as it is', () => {
    expect(drawnFloatOffset(null, BOUNDS)).toBeNull();
    expect(drawnFloatOffset({ inline: 9999, block: 0 }, null)).toEqual({ inline: 9999, block: 0 });
  });
});

describe('sameFloatBounds', () => {
  it('compares every measured length, and null only to null', () => {
    expect(sameFloatBounds(null, null)).toBe(true);
    expect(sameFloatBounds(null, BOUNDS)).toBe(false);
    expect(sameFloatBounds(BOUNDS, { ...BOUNDS })).toBe(true);
    for (const key of Object.keys(BOUNDS) as (keyof FloatBounds)[]) {
      expect(sameFloatBounds(BOUNDS, { ...BOUNDS, [key]: BOUNDS[key] + 1 }), key).toBe(false);
    }
  });
});
