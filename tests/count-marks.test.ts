// The pure count/takeoff math. Everything breakable about
// counting lives in `lib/count-marks.ts` so it can be tested without a DOM
// (this repo has none); the gestures in PageCell are covered by e2e spec 107.
import { describe, it, expect } from 'vitest';
import {
  COUNT_SYMBOLS,
  DEFAULT_COUNT_SYMBOL,
  UNGROUPED,
  countContents,
  countMarksOf,
  derivedGroups,
  grandTotal,
  groupOf,
  groupTotals,
  legendLayout,
  legendText,
  mergeGroups,
  nextGroupColor,
  nextSequence,
  summaryRows,
  symbolById,
  uniqueGroupName,
  type CountGroup,
} from '../src/renderer/lib/count-marks';
import type { PageAnnotation } from '../src/renderer/state/types';

let n = 0;
function mark(group: string, seq: number, over: Partial<PageAnnotation> = {}): PageAnnotation {
  return {
    id: `m${++n}`,
    kind: 'count',
    x: 0.1,
    y: 0.1,
    w: 0.02,
    h: 0.02,
    color: '#e0393e',
    countGroup: group,
    countSeq: seq,
    countSymbol: 'circle',
    note: countContents(group, seq),
    ...over,
  };
}

function other(kind: PageAnnotation['kind']): PageAnnotation {
  return { id: `o${++n}`, kind, x: 0, y: 0, w: 0.1, h: 0.1, color: '#000000' };
}

describe('the symbol registry', () => {
  it('has unique ids and non-empty parts', () => {
    const ids = COUNT_SYMBOLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of COUNT_SYMBOLS) expect(s.parts.length).toBeGreaterThan(0);
  });

  it('keeps every part inside the unit square', () => {
    // The appearance BBox is the unit square scaled — a part outside it would
    // be clipped on paper while showing fine in the SVG picker.
    for (const s of COUNT_SYMBOLS) {
      for (const part of s.parts) {
        if (part.kind === 'circle') {
          expect(part.cx - part.r).toBeGreaterThanOrEqual(0);
          expect(part.cx + part.r).toBeLessThanOrEqual(1);
          expect(part.cy - part.r).toBeGreaterThanOrEqual(0);
          expect(part.cy + part.r).toBeLessThanOrEqual(1);
        } else {
          for (const v of part.points) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('resolves an UNKNOWN symbol id to the default rather than throwing', () => {
    // A file counted by a later build must still open.
    expect(symbolById('a-symbol-from-2030').id).toBe(DEFAULT_COUNT_SYMBOL);
    expect(symbolById(undefined).id).toBe(DEFAULT_COUNT_SYMBOL);
  });
});

describe('groups', () => {
  it('picks the count marks out of a mixed page', () => {
    const page = [other('highlight'), mark('Doors', 1), other('stamp'), mark('Doors', 2)];
    expect(countMarksOf(page)).toHaveLength(2);
    expect(countMarksOf(undefined)).toEqual([]);
  });

  it('files a mark with no group under the engine’s own Ungrouped', () => {
    // The app and the CSV must agree on the total, so they must agree on the
    // bucket a group-less mark lands in.
    expect(groupOf(mark('', 1))).toBe(UNGROUPED);
    expect(groupOf(mark('   ', 1))).toBe(UNGROUPED);
  });

  it('derives groups in first-seen order, taking the look from the first mark', () => {
    const marks = [
      mark('Doors', 1, { color: '#111111', countSymbol: 'square' }),
      mark('Windows', 1, { color: '#222222', countSymbol: 'triangle' }),
      mark('Doors', 2, { color: '#999999', countSymbol: 'star' }),
    ];
    expect(derivedGroups(marks)).toEqual([
      { name: 'Doors', color: '#111111', symbol: 'square' },
      { name: 'Windows', color: '#222222', symbol: 'triangle' },
    ]);
  });

  it('lets the FILE win over a remembered group of the same name', () => {
    // Otherwise the next mark placed in "Doors" would be blue while the forty
    // already on the sheet stayed red — one group drawn two ways.
    const fromFile: CountGroup[] = [{ name: 'Doors', color: '#ff0000', symbol: 'square' }];
    const remembered: CountGroup[] = [
      { name: 'Doors', color: '#0000ff', symbol: 'star' },
      { name: 'Outlets', color: '#00ff00', symbol: 'cross' },
    ];
    expect(mergeGroups(fromFile, remembered)).toEqual([
      { name: 'Doors', color: '#ff0000', symbol: 'square' },
      { name: 'Outlets', color: '#00ff00', symbol: 'cross' },
    ]);
  });

  it('makes a fresh name unique', () => {
    const existing: CountGroup[] = [
      { name: 'Group', color: '#111111', symbol: 'circle' },
      { name: 'Group 2', color: '#111111', symbol: 'circle' },
    ];
    expect(uniqueGroupName('Group', existing)).toBe('Group 3');
    expect(uniqueGroupName('Doors', existing)).toBe('Doors');
  });

  it('gives a new group a colour nothing else is using', () => {
    const first = nextGroupColor([]);
    const second = nextGroupColor([{ name: 'a', color: first, symbol: 'circle' }]);
    expect(second).not.toBe(first);
  });
});

describe('sequence allocation', () => {
  it('numbers from one past the highest EVER used, not from the count', () => {
    // Counting 1..3 and deleting #2 leaves {1,3}. The next mark is 4: a
    // sequence number is a LABEL a user reads off the sheet, and reusing 3
    // would put two marks in the document claiming to be the same one.
    const marks = [mark('Doors', 1), mark('Doors', 3)];
    expect(nextSequence(marks, 'Doors')).toBe(4);
  });

  it('is per GROUP', () => {
    const marks = [mark('Doors', 7), mark('Windows', 2)];
    expect(nextSequence(marks, 'Windows')).toBe(3);
    expect(nextSequence(marks, 'Sinks')).toBe(1);
  });

  it('starts at one on an empty document', () => {
    expect(nextSequence([], 'Doors')).toBe(1);
  });

  it('composes /Contents from the group VERBATIM', () => {
    // The group name is the user's own text: never translated, never
    // normalized, never title-cased.
    expect(countContents('puertas de garaje', 12)).toBe('puertas de garaje 12');
  });
});

describe('derived tallies', () => {
  const pages = [
    [mark('Doors', 1), mark('Doors', 2), other('ink'), mark('Windows', 1)],
    [mark('Doors', 3), mark('Windows', 2, { countSymbol: 'triangle' })],
    [other('note')],
  ];

  it('reports one row per group per page, ordered by group then page', () => {
    expect(summaryRows(pages).map((r) => [r.group, r.page, r.count])).toEqual([
      ['Doors', 1, 2],
      ['Doors', 2, 1],
      ['Windows', 1, 1],
      ['Windows', 2, 1],
    ]);
  });

  it('totals per group and overall', () => {
    const rows = summaryRows(pages);
    expect(groupTotals(rows).map((r) => [r.group, r.count])).toEqual([
      ['Doors', 3],
      ['Windows', 2],
    ]);
    expect(grandTotal(rows)).toBe(5);
  });

  it('counts NOTHING on a document with no count marks', () => {
    expect(summaryRows([[other('stamp')], [other('highlight')]])).toEqual([]);
    expect(grandTotal([])).toBe(0);
  });
});

describe('the legend layout', () => {
  const rows = [
    { symbol: 'circle', group: 'Doors', color: '#ff0000', count: 12 },
    { symbol: 'square', group: 'Windows', color: '#00ff00', count: 7 },
  ];

  it('sizes the box for the longest name and every line', () => {
    const short = legendLayout(rows, 'Takeoff');
    const long = legendLayout(
      [...rows, { symbol: 'star', group: 'A very long trade name indeed', color: '#00f', count: 1 }],
      'Takeoff',
    );
    expect(long.widthPt).toBeGreaterThan(short.widthPt);
    expect(long.heightPt).toBeGreaterThan(short.heightPt);
  });

  it('lays the rows out top-down inside the box, with the total last', () => {
    const l = legendLayout(rows, 'Takeoff');
    expect(l.rows).toHaveLength(2);
    expect(l.rows[0].y).toBeLessThan(l.rows[1].y);
    expect(l.rows[1].y).toBeLessThan(l.totalY);
    expect(l.totalY).toBeLessThan(l.heightPt);
    expect(l.total).toBe(19);
  });

  it('writes the plain-text table /Contents carries', () => {
    expect(legendText(rows, 'Takeoff', 'Total')).toBe(
      'Takeoff\nDoors\t12\nWindows\t7\nTotal\t19',
    );
  });

  it('handles an empty legend without collapsing', () => {
    const l = legendLayout([], 'Takeoff');
    expect(l.total).toBe(0);
    expect(l.heightPt).toBeGreaterThan(0);
    expect(l.widthPt).toBeGreaterThan(0);
  });
});
