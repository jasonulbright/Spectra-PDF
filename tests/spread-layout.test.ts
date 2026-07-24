import { describe, expect, it } from 'vitest';
import { pagesInRow, rowCountOf, rowOfPage, type PageLayout } from '../src/renderer/canvas/spread-layout';

// The two invariants everything else hangs off:
//  1. round-trip: every page's row CONTAINS that page;
//  2. partition: the rows' page lists tile [0..n) exactly once, in order.
function checkPartition(n: number, layout: PageLayout, cover: boolean): void {
  const rows = rowCountOf(n, layout, cover);
  const seen: number[] = [];
  for (let r = 0; r < rows; r++) {
    const pages = pagesInRow(r, layout, cover, n);
    expect(pages.length).toBeGreaterThan(0); // no empty row inside the range
    expect(pages.length).toBeLessThanOrEqual(layout === 'single' ? 1 : 2);
    for (const p of pages) {
      expect(rowOfPage(p, layout, cover)).toBe(r); // round-trip
      seen.push(p);
    }
  }
  expect(seen).toEqual([...Array(n).keys()]); // exact tiling, in order
}

describe('spread-layout', () => {
  it('single layout is the identity (the shipped reading view, unregressable)', () => {
    for (const n of [0, 1, 2, 7, 100]) {
      expect(rowCountOf(n, 'single', false)).toBe(n);
      for (let i = 0; i < n; i++) {
        expect(rowOfPage(i, 'single', false)).toBe(i);
        expect(pagesInRow(i, 'single', false, n)).toEqual([i]);
      }
    }
  });

  it('two-up pairs (0,1)(2,3)…, odd tail alone', () => {
    expect(rowCountOf(6, 'two', false)).toBe(3);
    expect(rowCountOf(7, 'two', false)).toBe(4);
    expect(pagesInRow(0, 'two', false, 7)).toEqual([0, 1]);
    expect(pagesInRow(2, 'two', false, 7)).toEqual([4, 5]);
    expect(pagesInRow(3, 'two', false, 7)).toEqual([6]); // odd tail
    expect(rowOfPage(5, 'two', false)).toBe(2);
  });

  it('cover-alone puts page 0 by itself, then facing (1,2)(3,4)… — the book convention', () => {
    expect(rowCountOf(7, 'two', true)).toBe(4); // [0][1,2][3,4][5,6]
    expect(rowCountOf(6, 'two', true)).toBe(4); // [0][1,2][3,4][5]
    expect(pagesInRow(0, 'two', true, 7)).toEqual([0]);
    expect(pagesInRow(1, 'two', true, 7)).toEqual([1, 2]);
    expect(pagesInRow(3, 'two', true, 6)).toEqual([5]); // even tail alone
    expect(rowOfPage(0, 'two', true)).toBe(0);
    expect(rowOfPage(1, 'two', true)).toBe(1);
    expect(rowOfPage(2, 'two', true)).toBe(1);
    expect(rowOfPage(6, 'two', true)).toBe(3);
  });

  it('partition + round-trip hold for every mode across sizes 0-25', () => {
    for (let n = 0; n <= 25; n++) {
      checkPartition(n, 'single', false);
      checkPartition(n, 'two', false);
      checkPartition(n, 'two', true);
    }
  });

  it('degenerate inputs answer safely', () => {
    expect(rowCountOf(0, 'two', true)).toBe(0);
    expect(pagesInRow(-1, 'two', false, 5)).toEqual([]);
    expect(pagesInRow(9, 'two', false, 5)).toEqual([]); // past the end → empty
    expect(pagesInRow(0, 'single', false, 0)).toEqual([]);
  });
});
