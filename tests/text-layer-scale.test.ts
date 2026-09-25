import { describe, it, expect } from 'vitest';
import { textLayerScaleVars } from '../src/renderer/lib/text-layer-scale';

// The layer height pdf.js computes: --scale-factor × --user-unit × raw height.
const layerHeight = (vars: Record<string, string>, rawHeight: number): number =>
  Number(vars['--scale-factor']) * Number(vars['--user-unit']) * rawHeight;

describe('textLayerScaleVars', () => {
  it('sizes the layer to the rendered page on a UserUnit page', () => {
    const rawHeight = 792;
    const userUnit = 2.5;
    const layoutH = 1000;
    // viewport.scale as PageTextLayer derives it: layout height over the
    // scale-1 viewport height, which already carries the UserUnit.
    const scale = layoutH / (rawHeight * userUnit);
    expect(layerHeight(textLayerScaleVars({ scale, userUnit }), rawHeight)).toBeCloseTo(layoutH, 9);
  });

  it('is the plain scale on an ordinary page', () => {
    expect(textLayerScaleVars({ scale: 1.25, userUnit: 1 })).toEqual({ '--scale-factor': '1.25', '--user-unit': '1' });
  });
});
