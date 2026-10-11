import { describe, expect, it } from 'vitest';
import { pagesInRow, rowCountOf, rowOfPage } from '../src/renderer/canvas/spread-layout';

// The two invariants everything else hangs off:
//  1. round-trip: every page's row CONTAINS that page;
//  2. partition: the rows' page lists tile [0..n) exactly once, in order.
function checkPartition(n: number, columns: number, cover: boolean): void {
  const rows = rowCountOf(n, columns, cover);
  const seen: number[] = [];
  for (let r = 0; r < rows; r++) {
    const pages = pagesInRow(r, columns, cover, n);
    expect(pages.length).toBeGreaterThan(0); // no empty row inside the range
    expect(pages.length).toBeLessThanOrEqual(columns);
    for (const p of pages) {
      expect(rowOfPage(p, columns, cover)).toBe(r); // round-trip
      seen.push(p);
    }
  }
  expect(seen).toEqual([...Array(n).keys()]); // exact tiling, in order
}

describe('spread-layout', () => {
  it('single layout is the identity (the shipped reading view, unregressable)', () => {
    for (const n of [0, 1, 2, 7, 100]) {
      expect(rowCountOf(n, 1, false)).toBe(n);
      for (let i = 0; i < n; i++) {
        expect(rowOfPage(i, 1, false)).toBe(i);
        expect(pagesInRow(i, 1, false, n)).toEqual([i]);
      }
    }
  });

  it('two-up pairs (0,1)(2,3)…, odd tail alone', () => {
    expect(rowCountOf(6, 2, false)).toBe(3);
    expect(rowCountOf(7, 2, false)).toBe(4);
    expect(pagesInRow(0, 2, false, 7)).toEqual([0, 1]);
    expect(pagesInRow(2, 2, false, 7)).toEqual([4, 5]);
    expect(pagesInRow(3, 2, false, 7)).toEqual([6]); // odd tail
    expect(rowOfPage(5, 2, false)).toBe(2);
  });

  it('cover-alone puts page 0 by itself, then facing (1,2)(3,4)… — the book convention', () => {
    expect(rowCountOf(7, 2, true)).toBe(4); // [0][1,2][3,4][5,6]
    expect(rowCountOf(6, 2, true)).toBe(4); // [0][1,2][3,4][5]
    expect(pagesInRow(0, 2, true, 7)).toEqual([0]);
    expect(pagesInRow(1, 2, true, 7)).toEqual([1, 2]);
    expect(pagesInRow(3, 2, true, 6)).toEqual([5]); // even tail alone
    expect(rowOfPage(0, 2, true)).toBe(0);
    expect(rowOfPage(1, 2, true)).toBe(1);
    expect(rowOfPage(2, 2, true)).toBe(1);
    expect(rowOfPage(6, 2, true)).toBe(3);
  });

  it('partition + round-trip hold for every mode across sizes 0-25', () => {
    for (let n = 0; n <= 25; n++) {
      checkPartition(n, 1, false);
      checkPartition(n, 2, false);
      checkPartition(n, 2, true);
    }
  });

  it('degenerate inputs answer safely', () => {
    expect(rowCountOf(0, 2, true)).toBe(0);
    expect(pagesInRow(-1, 2, false, 5)).toEqual([]);
    expect(pagesInRow(9, 2, false, 5)).toEqual([]); // past the end → empty
    expect(pagesInRow(0, 1, false, 0)).toEqual([]);
  });

  it('partition + round-trip hold for every column count 1-7, cover on and off, sizes 0-40', () => {
    for (let c = 1; c <= 7; c++) {
      for (let n = 0; n <= 40; n++) {
        checkPartition(n, c, false);
        checkPartition(n, c, true);
      }
    }
  });

  it('one column ignores cover-alone: the single column has no facing order', () => {
    for (const n of [1, 2, 9]) {
      expect(rowCountOf(n, 1, true)).toBe(n);
      for (let i = 0; i < n; i++) expect(pagesInRow(i, 1, true, n)).toEqual([i]);
    }
  });

  it('three columns with the cover alone: [0][1,2,3][4,5,6][7]', () => {
    expect(rowCountOf(8, 3, true)).toBe(4);
    expect(pagesInRow(0, 3, true, 8)).toEqual([0]);
    expect(pagesInRow(1, 3, true, 8)).toEqual([1, 2, 3]);
    expect(pagesInRow(3, 3, true, 8)).toEqual([7]);
    expect(rowOfPage(4, 3, true)).toBe(2);
    expect(rowCountOf(8, 3, false)).toBe(3);
    expect(pagesInRow(2, 3, false, 8)).toEqual([6, 7]);
  });

  it('a non-integer or non-positive column count behaves as its floor, at least 1', () => {
    expect(rowCountOf(5, 0, false)).toBe(5);
    expect(rowCountOf(5, 2.9, false)).toBe(3);
    expect(pagesInRow(1, -3, false, 5)).toEqual([1]);
  });
});
