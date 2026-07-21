import { describe, it, expect } from 'vitest';
import { fetchEditVectors } from '../src/renderer/lib/edit-vectors';
import type { PageGeometry } from '../src/renderer/lib/redaction';

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
