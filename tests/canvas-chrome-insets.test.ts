import { describe, it, expect } from 'vitest';
import { canvasChromeInsets } from '../src/renderer/components/canvas/useCanvasChromeInsets';

describe('canvasChromeInsets', () => {
  it('measures the tool strip above and the status bar below the document region', () => {
    // strip 34px, region 520px, status bar 28px in a 582px view.
    const insets = canvasChromeInsets(582, [
      { top: 0, height: 34 },
      { top: 34, height: 520 },
      { top: 554, height: 28 },
    ]);
    expect(insets).toEqual({ start: 34, end: 28 });
  });

  it('counts a wrapped strip and a banner above the region', () => {
    const insets = canvasChromeInsets(600, [
      { top: 0, height: 60 },
      { top: 60, height: 24 },
      { top: 84, height: 488 },
      { top: 572, height: 28 },
    ]);
    expect(insets).toEqual({ start: 84, end: 28 });
  });

  it('is zero with no chrome or no children', () => {
    expect(canvasChromeInsets(500, [{ top: 0, height: 500 }])).toEqual({ start: 0, end: 0 });
    expect(canvasChromeInsets(500, [])).toEqual({ start: 0, end: 0 });
  });
});
