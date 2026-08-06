// The pointer arithmetic CSS logical properties cannot fix. A drag that
// computes a width from a raw clientX delta runs BACKWARDS under `dir=rtl` —
// dragging to widen narrows — and the failure is invisible to a screenshot
// review. The sign convention lives in one module so a fourth drag site
// cannot invent a fourth one.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { inlineDelta, inlineExtent, isRtlUi } from '../src/renderer/lib/inline-direction';

/** The renderer reads `<html dir>`, the one place UI direction is set. */
function withDirection(dir: string): void {
  vi.stubGlobal('document', { documentElement: { dir } });
}
afterEach(() => vi.unstubAllGlobals());

describe('inline direction', () => {
  it('is left-to-right when no document says otherwise', () => {
    expect(isRtlUi()).toBe(false);
    expect(inlineDelta(12)).toBe(12);
  });

  it('flips a pointer delta under rtl and leaves it alone under ltr', () => {
    withDirection('ltr');
    expect(inlineDelta(12)).toBe(12);
    expect(inlineDelta(-12)).toBe(-12);
    withDirection('rtl');
    expect(inlineDelta(12)).toBe(-12);
    expect(inlineDelta(-12)).toBe(12);
  });

  it('measures a start-anchored pane from whichever edge is inline-start', () => {
    const bounds = { left: 100, right: 400 };
    withDirection('ltr');
    expect(inlineExtent(bounds, 250, 'start')).toBe(150);
    withDirection('rtl');
    expect(inlineExtent(bounds, 250, 'start')).toBe(150);
  });

  it('measures an end-anchored pane from whichever edge is inline-end', () => {
    const bounds = { left: 100, right: 400 };
    withDirection('ltr');
    expect(inlineExtent(bounds, 250, 'end')).toBe(150);
    withDirection('rtl');
    expect(inlineExtent(bounds, 250, 'end')).toBe(150);
  });

  it('grows both panes when the pointer moves the way that widens them', () => {
    // The defect this exists to stop: a handle dragged to widen that narrows.
    const bounds = { left: 100, right: 400 };
    withDirection('ltr');
    expect(inlineExtent(bounds, 300, 'start')).toBeGreaterThan(
      inlineExtent(bounds, 250, 'start'),
    );
    expect(inlineExtent(bounds, 200, 'end')).toBeGreaterThan(inlineExtent(bounds, 250, 'end'));
    withDirection('rtl');
    expect(inlineExtent(bounds, 200, 'start')).toBeGreaterThan(
      inlineExtent(bounds, 250, 'start'),
    );
    expect(inlineExtent(bounds, 300, 'end')).toBeGreaterThan(inlineExtent(bounds, 250, 'end'));
  });
});
