import { describe, it, expect, beforeEach } from 'vitest';
import {
  insetsFromBand,
  roundInsets,
  publishDrawnCrop,
  subscribeDrawnCrop,
  consumeDrawnCrop,
  __resetDrawnCrop,
  resizeCropBand,
  cropBandChanged,
  type DrawnCrop,
} from '../src/renderer/lib/crop-draw';

// A US Letter page, unrotated.
const W = 612;
const H = 792;

describe('insetsFromBand', () => {
  it('converts a centred band to per-edge points', () => {
    // Quarter in from every edge.
    const out = insetsFromBand({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, W, H);
    expect(out).not.toBeNull();
    expect(out!.left).toBeCloseTo(153, 6);
    expect(out!.right).toBeCloseTo(153, 6);
    expect(out!.top).toBeCloseTo(198, 6);
    expect(out!.bottom).toBeCloseTo(198, 6);
  });

  it('a full-page band trims nothing', () => {
    const out = insetsFromBand({ x: 0, y: 0, w: 1, h: 1 }, W, H)!;
    expect(out).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it('measures top from the TOP and bottom from the bottom', () => {
    // A band hugging the top edge: nothing trimmed off the top, most off
    // the bottom. Getting this backwards is the classic y-flip bug.
    const out = insetsFromBand({ x: 0, y: 0, w: 1, h: 0.25 }, W, H)!;
    expect(out.top).toBeCloseTo(0, 6);
    expect(out.bottom).toBeCloseTo(594, 6);
  });

  it('rejects a click or a hairline rather than cropping everything', () => {
    expect(insetsFromBand({ x: 0.5, y: 0.5, w: 0, h: 0 }, W, H)).toBeNull();
    expect(insetsFromBand({ x: 0.5, y: 0.5, w: 0.0005, h: 0.4 }, W, H)).toBeNull();
  });

  it('refuses a page with no measurable size', () => {
    expect(insetsFromBand({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 0, H)).toBeNull();
    expect(insetsFromBand({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, W, -1)).toBeNull();
  });

  it('clamps a band dragged past the page edge', () => {
    const out = insetsFromBand({ x: -0.2, y: -0.2, w: 2, h: 2 }, W, H)!;
    expect(out).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe('insetsFromBand under /Rotate', () => {
  // The band always describes what the user SEES. The insets describe the
  // unrotated page box. A band hugging the DISPLAYED top must trim the
  // page edge that is currently shown at the top — which rotation moves.
  const band = { x: 0, y: 0, w: 1, h: 0.25 }; // displayed top quarter kept

  it('90 degrees: the displayed top IS the page left', () => {
    // /Rotate turns the page clockwise for display, so the page's left edge
    // swings up to the top. Keeping the displayed top quarter therefore
    // trims the displayed bottom — which is the page's RIGHT edge.
    const out = insetsFromBand(band, W, H, 90)!;
    expect(out.left).toBeCloseTo(0, 6);
    expect(out.right).toBeCloseTo(594, 6);
    expect(out.top).toBeCloseTo(0, 6);
    expect(out.bottom).toBeCloseTo(0, 6);
  });

  it('180 degrees flips top and bottom', () => {
    const out = insetsFromBand(band, W, H, 180)!;
    expect(out.bottom).toBeCloseTo(0, 6);
    expect(out.top).toBeCloseTo(594, 6);
  });

  it('270 degrees: the displayed top IS the page right', () => {
    const out = insetsFromBand(band, W, H, 270)!;
    expect(out.right).toBeCloseTo(0, 6);
    expect(out.left).toBeCloseTo(594, 6);
  });

  it('normalises odd rotation values the way /Rotate does', () => {
    const at90 = insetsFromBand(band, W, H, 90)!;
    expect(insetsFromBand(band, W, H, 450)).toEqual(at90);
    expect(insetsFromBand(band, W, H, -270)).toEqual(at90);
  });

  it('a full turn is the same as none', () => {
    expect(insetsFromBand(band, W, H, 360)).toEqual(insetsFromBand(band, W, H, 0));
  });
});

describe('roundInsets', () => {
  it('rounds to the panel fields’ precision so drawn and typed agree', () => {
    const out = roundInsets({ top: 1.23456, bottom: 2.5, left: 0.001, right: 9.999 });
    expect(out).toEqual({ top: 1.23, bottom: 2.5, left: 0, right: 10 });
  });
});

describe('the drawn-crop channel', () => {
  beforeEach(() => __resetDrawnCrop());

  const crop = { top: 10, bottom: 20, left: 30, right: 40, page: 3, path: 'C:/docs/a.pdf' };

  it('delivers a publish to every live subscriber', () => {
    const seen: DrawnCrop[] = [];
    subscribeDrawnCrop((c) => seen.push(c));
    subscribeDrawnCrop((c) => seen.push(c));
    publishDrawnCrop(crop);
    expect(seen).toEqual([crop, crop]);
  });

  it('holds the crop for a panel that mounts after the draw', () => {
    publishDrawnCrop(crop);
    expect(consumeDrawnCrop()).toEqual(crop);
  });

  it('consumes once — a remount must not refill fields with an applied crop', () => {
    publishDrawnCrop(crop);
    expect(consumeDrawnCrop()).toEqual(crop);
    expect(consumeDrawnCrop()).toBeNull();
  });

  it('starts empty', () => {
    expect(consumeDrawnCrop()).toBeNull();
  });

  it('stops delivering after unsubscribe', () => {
    const seen: DrawnCrop[] = [];
    const off = subscribeDrawnCrop((c) => seen.push(c));
    publishDrawnCrop(crop);
    off();
    publishDrawnCrop({ ...crop, page: 9 });
    expect(seen).toEqual([crop]);
  });

  it('a later publish replaces the pending one', () => {
    publishDrawnCrop(crop);
    publishDrawnCrop({ ...crop, page: 7 });
    expect(consumeDrawnCrop()?.page).toBe(7);
  });
});

describe('resizeCropBand', () => {
  const band = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

  it('moves only the dragged edge, anchoring the opposite one', () => {
    const out = resizeCropBand(band, 'e', 0.8, 0.5);
    expect(out.x).toBeCloseTo(0.2, 6);
    expect(out.y).toBeCloseTo(0.2, 6);
    expect(out.w).toBeCloseTo(0.6, 6);
    expect(out.h).toBeCloseTo(0.4, 6);
  });

  it('moves both axes from a corner', () => {
    const out = resizeCropBand(band, 'nw', 0.1, 0.05);
    expect(out.x).toBeCloseTo(0.1, 6);
    expect(out.y).toBeCloseTo(0.05, 6);
    expect(out.x + out.w).toBeCloseTo(0.6, 6);
    expect(out.y + out.h).toBeCloseTo(0.6, 6);
  });

  it('clamps to the page box — a crop can never leave the page', () => {
    const out = resizeCropBand(band, 'se', 4, -3);
    expect(out.x + out.w).toBeLessThanOrEqual(1);
    expect(out.y).toBeGreaterThanOrEqual(0);
    expect(out.y + out.h).toBeLessThanOrEqual(1);
  });

  it('a crossed drag floors instead of flipping', () => {
    const out = resizeCropBand(band, 'w', 0.95, 0.5);
    expect(out.w).toBeGreaterThan(0);
    expect(out.x + out.w).toBeCloseTo(0.6, 6);
  });

  // The floor must clear insetsFromBand's own no-area threshold, or a
  // resize could produce a band the panel refuses as a click.
  it('never collapses into a band insetsFromBand rejects', () => {
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      const out = resizeCropBand(band, h, 0.4, 0.4);
      expect(insetsFromBand(out, W, H)).not.toBeNull();
    }
  });

  it('holds the aspect when asked', () => {
    const wide = { x: 0.1, y: 0.1, w: 0.4, h: 0.2 };
    const out = resizeCropBand(wide, 'se', 0.9, 0.15, true);
    expect(out.w / out.h).toBeCloseTo(2, 6);
  });
});

describe('cropBandChanged', () => {
  const band = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

  it('a press with no travel changes nothing', () => {
    expect(cropBandChanged(band, { ...band })).toBe(false);
  });

  it('any moved edge counts', () => {
    expect(cropBandChanged(band, { ...band, w: 0.41 })).toBe(true);
    expect(cropBandChanged(band, { ...band, y: 0.19 })).toBe(true);
  });
});
