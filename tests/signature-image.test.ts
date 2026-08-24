// Background removal for an IMPORTED signature image.
//
// The judgement — which pixels are the sheet, where the ink actually ends —
// is what makes an imported signature a signature rather than an opaque
// sticker, and there is no DOM test environment, so it lives in a pure module
// and is pinned here.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKGROUND_THRESHOLD,
  luminance,
  removeBackground,
  visibleBounds,
} from '../src/renderer/lib/signature-image';

/** width x height of opaque pixels from a per-pixel [r,g,b] source. */
function image(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b] = at(x, y);
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
}

const alphaAt = (buf: Uint8ClampedArray, w: number, x: number, y: number): number =>
  buf[(y * w + x) * 4 + 3];

describe('luminance', () => {
  it('weights the channels perceptually rather than averaging them', () => {
    // A saturated blue pen is far darker to the eye than its mean channel
    // value says; a mean would put it above a white-ish threshold and erase
    // the signature along with the sheet.
    const blue = luminance(0, 0, 255);
    expect(blue).toBeLessThan(DEFAULT_BACKGROUND_THRESHOLD);
    expect(blue).toBeLessThan((0 + 0 + 255) / 3);
    expect(luminance(255, 255, 255)).toBeCloseTo(255, 6);
    expect(luminance(0, 0, 0)).toBe(0);
  });
});

describe('removeBackground', () => {
  it('clears the sheet and keeps the ink', () => {
    const w = 4;
    const h = 1;
    // x=0 white sheet, x=1 black ink, x=2 blue ink, x=3 light grey sheet.
    const src = image(w, h, (x) =>
      x === 0 ? [255, 255, 255] : x === 1 ? [10, 10, 10] : x === 2 ? [0, 0, 200] : [245, 245, 245],
    );
    const out = removeBackground(src, DEFAULT_BACKGROUND_THRESHOLD);
    expect(alphaAt(out, w, 0, 0)).toBe(0);
    expect(alphaAt(out, w, 1, 0)).toBe(255);
    expect(alphaAt(out, w, 2, 0)).toBe(255);
    expect(alphaAt(out, w, 3, 0)).toBe(0);
  });

  it('never mutates the source, so the removal stays reversible', () => {
    const src = image(2, 1, () => [255, 255, 255]);
    const before = [...src];
    removeBackground(src, 128);
    expect([...src]).toEqual(before);
  });

  it('ramps the half-tones instead of cutting a stair-step edge', () => {
    // A pen's own antialiasing is exactly the band a hard cut would split.
    const w = 1;
    const grey = (v: number): Uint8ClampedArray => image(w, 1, () => [v, v, v]);
    const threshold = 200;
    const justUnder = alphaAt(removeBackground(grey(195), threshold), w, 0, 0);
    const wellUnder = alphaAt(removeBackground(grey(175), threshold), w, 0, 0);
    expect(justUnder).toBeGreaterThan(0);
    expect(justUnder).toBeLessThan(255);
    expect(wellUnder).toBeGreaterThan(justUnder);
  });

  it('moves the boundary with the threshold', () => {
    const w = 1;
    const mid = image(w, 1, () => [140, 140, 140]);
    expect(alphaAt(removeBackground(mid, 250), w, 0, 0)).toBe(255);
    expect(alphaAt(removeBackground(mid, 100), w, 0, 0)).toBe(0);
  });

  it('leaves an already-transparent pixel alone', () => {
    const src = image(1, 1, () => [10, 10, 10]);
    src[3] = 0;
    expect(alphaAt(removeBackground(src, 250), 1, 0, 0)).toBe(0);
  });
});

describe('visibleBounds', () => {
  it('trims to the ink so the saved aspect is the signature s, not the sheet s', () => {
    const w = 10;
    const h = 6;
    // Ink in a 3x2 block at (4,2); everything else white.
    const src = image(w, h, (x, y) =>
      x >= 4 && x <= 6 && y >= 2 && y <= 3 ? [0, 0, 0] : [255, 255, 255],
    );
    const box = visibleBounds(removeBackground(src, DEFAULT_BACKGROUND_THRESHOLD), w, h)!;
    expect(box).toEqual({ x: 4, y: 2, w: 3, h: 2 });
  });

  it('reports nothing when the threshold erased everything', () => {
    const src = image(4, 4, () => [255, 255, 255]);
    expect(visibleBounds(removeBackground(src, 200), 4, 4)).toBeNull();
  });

  it('ignores the feather s nearly-transparent skirt', () => {
    const w = 3;
    const h = 1;
    // One near-threshold pixel (a feathered edge) beside one solid ink pixel.
    const src = image(w, h, (x) =>
      x === 0 ? [0, 0, 0] : x === 1 ? [199, 199, 199] : [255, 255, 255],
    );
    const box = visibleBounds(removeBackground(src, 200), w, h)!;
    expect(box.w).toBe(1);
    expect(box.x).toBe(0);
  });
});
