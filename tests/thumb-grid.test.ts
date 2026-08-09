// The Pages panel's layout math. Every number here feeds a drag that MOVES
// pages, and the panel itself has no test environment.
import { describe, expect, it } from 'vitest';
import {
  MIN_COL_W,
  ROW_H,
  SIDE_PAD,
  thumbDropIndex,
  thumbGrid,
  thumbSlot,
  thumbWindow,
} from '../src/renderer/lib/thumb-grid';

describe('thumbGrid', () => {
  it('adds a column as the pane widens', () => {
    expect(thumbGrid(240, 10).columns).toBe(1);
    expect(thumbGrid(300, 10).columns).toBe(2);
    expect(thumbGrid(560, 10).columns).toBe(4);
  });

  it('never drops below one column, however narrow', () => {
    expect(thumbGrid(0, 10).columns).toBe(1);
    expect(thumbGrid(40, 10).columns).toBe(1);
  });

  it('spreads the leftover across the columns', () => {
    const g = thumbGrid(300 + SIDE_PAD * 2, 10);
    expect(g.columns).toBe(2);
    expect(g.columnWidth).toBe(150);
    expect(g.columnWidth).toBeGreaterThanOrEqual(MIN_COL_W);
  });

  it('counts the rows a page count needs', () => {
    expect(thumbGrid(560, 0).rows).toBe(0);
    expect(thumbGrid(560, 1).rows).toBe(1);
    expect(thumbGrid(560, 4).rows).toBe(1);
    expect(thumbGrid(560, 5).rows).toBe(2);
  });
});

describe('thumbSlot', () => {
  it('lays items out in reading order', () => {
    const g = thumbGrid(300 + SIDE_PAD * 2, 6); // 2 columns of 150
    expect(thumbSlot(0, g)).toEqual({ top: 0, left: SIDE_PAD, width: 150 });
    expect(thumbSlot(1, g)).toEqual({ top: 0, left: SIDE_PAD + 150, width: 150 });
    expect(thumbSlot(2, g)).toEqual({ top: ROW_H, left: SIDE_PAD, width: 150 });
  });
});

describe('thumbWindow', () => {
  const g = thumbGrid(300 + SIDE_PAD * 2, 100); // 2 columns

  it('covers the visible rows plus the overscan', () => {
    const w = thumbWindow(0, ROW_H * 3, g, 100, 1);
    expect(w.start).toBe(0);
    // 3 visible rows + 1 overscan row = 4 rows of 2.
    expect(w.end).toBe(8);
  });

  it('moves with the scroll', () => {
    const w = thumbWindow(ROW_H * 10, ROW_H * 2, g, 100, 1);
    expect(w.start).toBe(9 * 2);
    expect(w.end).toBe(13 * 2);
  });

  it('never runs past the item count', () => {
    const w = thumbWindow(ROW_H * 90, ROW_H * 10, g, 100, 3);
    expect(w.end).toBe(100);
    expect(w.start).toBeLessThanOrEqual(100);
  });
});

describe('thumbDropIndex with one column', () => {
  // One column is a LIST: y decides, and x must not, because a drag straight
  // down the middle would otherwise flip its target on horizontal jitter.
  const g = thumbGrid(240, 6);

  it('reads the gap from y alone', () => {
    expect(g.columns).toBe(1);
    expect(thumbDropIndex(0, 4, g, 6)).toBe(0);
    expect(thumbDropIndex(0, ROW_H - 6, g, 6)).toBe(1);
    expect(thumbDropIndex(0, ROW_H * 2 - 6, g, 6)).toBe(2);
  });

  it('ignores x entirely', () => {
    const y = ROW_H * 2 - 6;
    expect(thumbDropIndex(0, y, g, 6)).toBe(thumbDropIndex(999, y, g, 6));
  });

  it('clamps to the ends', () => {
    expect(thumbDropIndex(0, -500, g, 6)).toBe(0);
    expect(thumbDropIndex(0, 99999, g, 6)).toBe(6);
  });
});

describe('thumbDropIndex', () => {
  const g = thumbGrid(300 + SIDE_PAD * 2, 6); // 2 columns of 150

  it('names the gap BEFORE an item when the pointer is on its leading half', () => {
    expect(thumbDropIndex(SIDE_PAD + 10, 4, g, 6)).toBe(0);
    expect(thumbDropIndex(SIDE_PAD + 140, 4, g, 6)).toBe(1);
  });

  it('folds the gap past the last column onto the next row', () => {
    // Right of both columns in row 0 → the gap before row 1's first item.
    expect(thumbDropIndex(SIDE_PAD + 400, 4, g, 6)).toBe(2);
  });

  it('reads the row from y', () => {
    expect(thumbDropIndex(SIDE_PAD + 10, ROW_H * 2 + 4, g, 6)).toBe(4);
  });

  it('clamps to the ends', () => {
    expect(thumbDropIndex(-500, -500, g, 6)).toBe(0);
    expect(thumbDropIndex(9999, 9999, g, 6)).toBe(6);
  });
});
