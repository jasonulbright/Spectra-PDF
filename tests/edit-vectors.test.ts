import { describe, it, expect } from 'vitest';
import { fetchEditVectors, rgb01ToHex, hex01ToRgb } from '../src/renderer/lib/edit-vectors';
import type { PageGeometry } from '../src/renderer/lib/redaction';

describe('D3 colour helpers', () => {
  it('rgb01ToHex round-trips and clamps', () => {
    expect(rgb01ToHex([1, 0, 0])).toBe('#ff0000');
    expect(rgb01ToHex([0, 1, 0])).toBe('#00ff00');
    expect(rgb01ToHex([0, 0, 1])).toBe('#0000ff');
    expect(rgb01ToHex(null)).toBe('#000000');
    expect(rgb01ToHex([2, -1, 0.5])).toBe('#ff0080'); // clamped
  });
  it('hex01ToRgb parses and falls back to black', () => {
    expect(hex01ToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hex01ToRgb('00ff00')).toEqual([0, 1, 0]);
    expect(hex01ToRgb('nonsense')).toEqual([0, 0, 0]);
  });
});

const GEO: PageGeometry = {
  box: { x: 0, y: 0, width: 400, height: 300 },
  bakedRotate: 0,
};

function mockCall(vectors: unknown[]): (m: string, p: Record<string, unknown>) => Promise<unknown> {
  return async () => ({ vectors });
}

describe('fetchEditVectors (9.D1)', () => {
  it('maps kind, clamps colours, and projects the rect', async () => {
    const out = await fetchEditVectors(
      mockCall([
        { index: 0, rect: [40, 40, 140, 100], kind: 'fill', fill: [1, 0, 0], stroke: null },
        { index: 1, rect: [0, 0, 400, 300], kind: 'stroke', fill: null, stroke: [0, 0, 1] },
        { index: 2, rect: [10, 10, 20, 20], kind: 'fillstroke', fill: [0, 1, 0], stroke: [1, 1, 0] },
      ]),
      '/w.pdf',
      1,
      GEO,
    );
    expect(out.map((v) => v.kind)).toEqual(['fill', 'stroke', 'fillstroke']);
    expect(out[0].fill).toEqual([1, 0, 0]);
    expect(out[0].stroke).toBeNull();
    expect(out[1].stroke).toEqual([0, 0, 1]);
    // The rect is projected into display-normalized space (0..1).
    expect(out[0].rect.x).toBeGreaterThanOrEqual(0);
    expect(out[0].rect.w).toBeGreaterThan(0);
  });

  it('defaults an unknown kind to fill and nulls malformed colours', async () => {
    const out = await fetchEditVectors(
      mockCall([
        { index: 0, rect: [0, 0, 10, 10], kind: 'weird', fill: [1, 2], stroke: 'nope' },
        { index: 1, rect: [0, 0, 10, 10], kind: 'fill', fill: null, stroke: undefined },
      ]),
      '/w.pdf',
      1,
      GEO,
    );
    expect(out[0].kind).toBe('fill');
    expect(out[0].fill).toBeNull(); // wrong length
    expect(out[0].stroke).toBeNull(); // not an array
    expect(out[1].fill).toBeNull();
    expect(out[1].stroke).toBeNull();
  });

  it('handles a missing vectors array', async () => {
    const out = await fetchEditVectors(async () => ({}), '/w.pdf', 1, GEO);
    expect(out).toEqual([]);
  });
});
