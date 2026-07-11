import { describe, expect, it } from 'vitest';
import {
  scaleRegionToDisplay,
  listableVisualPages,
} from '../src/renderer/lib/visual-compare';
import type { VisualPagePair } from '../src/renderer/lib/visual-compare';

describe('scaleRegionToDisplay', () => {
  it('projects points to display px with a pure scale factor', () => {
    // Page 400pt wide displayed at 380px → s = 0.95.
    const r = scaleRegionToDisplay({ x: 50, y: 40, w: 260, h: 60 }, 400, 380);
    expect(r.left).toBeCloseTo(50 * 0.95);
    expect(r.top).toBeCloseTo(40 * 0.95);
    expect(r.width).toBeCloseTo(260 * 0.95);
    expect(r.height).toBeCloseTo(60 * 0.95);
  });

  it('is identity when display width equals page width', () => {
    const r = scaleRegionToDisplay({ x: 10, y: 20, w: 30, h: 40 }, 500, 500);
    expect(r).toEqual({ left: 10, top: 20, width: 30, height: 40 });
  });

  it('degrades to zero, not NaN/Infinity, on a zero-width page', () => {
    const r = scaleRegionToDisplay({ x: 10, y: 20, w: 30, h: 40 }, 0, 380);
    expect(r).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it('regions in the padded band beyond a narrower page still project (clipped by the host)', () => {
    // Compare space 500pt (B wider); A page is 400pt shown at 400px (s=1).
    // A region at x=450 projects past A's canvas — the viewer clips it.
    const r = scaleRegionToDisplay({ x: 450, y: 0, w: 50, h: 10 }, 400, 400);
    expect(r.left).toBe(450);
  });
});

describe('listableVisualPages', () => {
  const pages: VisualPagePair[] = [
    { page: 1, identical: true, regions: [] },
    { page: 2, identical: false, regions: [{ x: 0, y: 0, w: 10, h: 10 }] },
    { page: 3, identical: true, regions: [] },
    { page: 4, only_in: 'b' },
  ];

  it('lists differing pairs and unpaired extras, not identical pairs', () => {
    const listed = listableVisualPages(pages);
    expect(listed.map((p) => p.page)).toEqual([2, 4]);
  });

  it('empty when everything is identical', () => {
    expect(listableVisualPages([{ page: 1, identical: true }])).toEqual([]);
  });
});
