import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  computeDropTarget,
  betweenSlotY,
  pageDisplayWidth,
  displayWidthOf,
  wrapPages,
  rowWidth,
  BASE_PAGE_HEIGHT,
  CARD_PAD_X,
  PAGE_GAP,
  ROW_GAP,
  ROWS_TOP,
  DOC_HEIGHT,
  DOC_SLOT,
  DOC_GAP_Y,
  MIN_DOC_WIDTH,
  MAX_ROW_WIDTH,
  ADD_GHOST_WIDTH,
} from '../src/renderer/canvas/layout';
import type { OpenDocument, PageRef } from '../src/renderer/state/types';

function makePages(path: string, sizes: [number, number][]): PageRef[] {
  return sizes.map(([width, height], i) => ({
    id: `${path}#p${i}`,
    sourceDocId: path,
    sourcePageIndex: i,
    rotation: 0 as const,
    width,
    height,
  }));
}

function makeDoc(id: string, path: string, sizes: [number, number][]): OpenDocument {
  return {
    id,
    path,
    workingPath: `${path}.working`,
    name: id,
    pageCount: sizes.length,
    buffer: [1],
    dirty: false,
    undoStack: [],
    redoStack: [],
    pages: makePages(path, sizes),
  };
}

const LETTER: [number, number] = [612, 792];

describe('pageDisplayWidth', () => {
  it('scales width to the base page height', () => {
    expect(pageDisplayWidth(612, 792)).toBe(Math.round((BASE_PAGE_HEIGHT * 612) / 792));
    expect(pageDisplayWidth(792, 612)).toBe(Math.round((BASE_PAGE_HEIGHT * 792) / 612));
  });

  it('falls back to the reference width for unresolved (0×0) dimensions', () => {
    expect(pageDisplayWidth(0, 0)).toBe(Math.round((BASE_PAGE_HEIGHT * 612) / 792));
  });
});

describe('displayWidthOf', () => {
  it('swaps the aspect for pending 90°/270° rotations', () => {
    const page = { id: 'p', width: 612, height: 792 };
    const portrait = pageDisplayWidth(612, 792);
    const landscape = pageDisplayWidth(792, 612);
    expect(displayWidthOf({ ...page, rotation: 0 })).toBe(portrait);
    expect(displayWidthOf({ ...page, rotation: 90 })).toBe(landscape);
    expect(displayWidthOf({ ...page, rotation: 180 })).toBe(portrait);
    expect(displayWidthOf({ ...page, rotation: 270 })).toBe(landscape);
  });
});

describe('computeLayout', () => {
  it('stacks documents vertically with the doc gap', () => {
    const docs = [makeDoc('a', 'a.pdf', [LETTER, LETTER]), makeDoc('b', 'b.pdf', [LETTER])];
    const layout = computeLayout(docs);
    expect(layout.items).toHaveLength(2);
    expect(layout.items[0].y).toBe(0);
    expect(layout.items[1].y).toBe(DOC_HEIGHT + DOC_GAP_Y);
    expect(layout.items.every((i) => i.x === 0)).toBe(true);
    expect(layout.items.every((i) => i.height === DOC_HEIGHT)).toBe(true);
    expect(layout.slotHeight).toBe(DOC_SLOT);
  });

  it('reserves an extra slot after the last document (Add-document ghost)', () => {
    const layout = computeLayout([makeDoc('a', 'a.pdf', [LETTER])]);
    expect(layout.contentHeight).toBe(DOC_HEIGHT + DOC_GAP_Y + DOC_HEIGHT);
  });

  it('gives small documents the minimum width', () => {
    const layout = computeLayout([makeDoc('a', 'a.pdf', [LETTER])]);
    expect(layout.items[0].width).toBe(MIN_DOC_WIDTH);
    expect(layout.contentWidth).toBe(MIN_DOC_WIDTH);
  });

  it('widens content to the widest strip', () => {
    const many = Array.from({ length: 12 }, () => LETTER);
    const layout = computeLayout([
      makeDoc('a', 'a.pdf', [LETTER]),
      makeDoc('b', 'b.pdf', many),
    ]);
    expect(layout.items[1].width).toBeGreaterThan(MIN_DOC_WIDTH);
    expect(layout.contentWidth).toBe(layout.items[1].width);
  });

  it('wraps long strips into rows instead of growing unboundedly wide', () => {
    const letterW = pageDisplayWidth(...LETTER);
    const perRow = Math.floor((MAX_ROW_WIDTH + PAGE_GAP) / (letterW + PAGE_GAP));
    const pages = Array.from({ length: perRow * 2 }, () => LETTER);
    const layout = computeLayout([makeDoc('long', 'long.pdf', pages)]);
    const item = layout.items[0];
    expect(item.width).toBeLessThanOrEqual(MAX_ROW_WIDTH + CARD_PAD_X * 2);
    expect(item.height).toBe(DOC_HEIGHT + BASE_PAGE_HEIGHT + ROW_GAP); // two rows
    // Vertical stacking uses the real (taller) height.
    const two = computeLayout([
      makeDoc('long', 'long.pdf', pages),
      makeDoc('b', 'b.pdf', [LETTER]),
    ]);
    expect(two.items[1].y).toBe(item.height + DOC_GAP_Y);
  });

  it('handles an empty workspace', () => {
    const layout = computeLayout([]);
    expect(layout.items).toEqual([]);
    expect(layout.contentWidth).toBe(1);
    expect(layout.contentHeight).toBe(1);
  });
});

describe('computeDropTarget', () => {
  const docs = [
    makeDoc('a', 'a.pdf', [LETTER, LETTER, LETTER]),
    makeDoc('b', 'b.pdf', [LETTER]),
  ];
  const layout = computeLayout(docs);
  const pageW = pageDisplayWidth(...LETTER);

  it('targets into a document row at full scale', () => {
    const target = computeDropTarget(layout, CARD_PAD_X + 1, DOC_HEIGHT / 2, 1, null, true);
    expect(target).toEqual({ kind: 'into', docId: 'a', index: 0 });
  });

  it('computes the insertion index from page midpoints', () => {
    // Just past the first page's midpoint → index 1
    const x = CARD_PAD_X + pageW / 2 + 1;
    const target = computeDropTarget(layout, x, DOC_HEIGHT / 2, 1, null, true);
    expect(target).toEqual({ kind: 'into', docId: 'a', index: 1 });
    // Beyond every page → append index
    const end = CARD_PAD_X + 3 * (pageW + PAGE_GAP) + 10;
    expect(computeDropTarget(layout, end, DOC_HEIGHT / 2, 1, null, true)).toEqual({
      kind: 'into',
      docId: 'a',
      index: 3,
    });
  });

  it('skips the excluded (dragged) page when counting indices', () => {
    // Mixed widths: with uniform pages, removing one slot shifts boundaries
    // and indices in lockstep, so only a wide excluded page shows the effect.
    const wide: [number, number] = [792, 612];
    const mixed = computeLayout([makeDoc('m', 'm.pdf', [wide, LETTER, LETTER])]);
    const letterW = pageDisplayWidth(...LETTER);
    const x = CARD_PAD_X + letterW / 2 + 42; // past letter midpoint, before wide midpoint
    expect(computeDropTarget(mixed, x, DOC_HEIGHT / 2, 1, null, true)).toEqual({
      kind: 'into',
      docId: 'm',
      index: 0,
    });
    expect(computeDropTarget(mixed, x, DOC_HEIGHT / 2, 1, new Set(['m.pdf#p0']), true)).toEqual({
      kind: 'into',
      docId: 'm',
      index: 1,
    });
  });

  it('excludes every page of a multi-page drag from the insertion index', () => {
    // Four uniform letter pages; drop past the 3rd remaining slot while the
    // first two pages are the ones being dragged (excluded from counting).
    const four = computeLayout([makeDoc('m', 'm.pdf', [LETTER, LETTER, LETTER, LETTER])]);
    const letterW = pageDisplayWidth(...LETTER);
    // With p0+p1 excluded, the remaining row is [p2, p3]; a point past p2's
    // midpoint lands at index 1 among the two remaining pages.
    const x = CARD_PAD_X + letterW + PAGE_GAP + 4;
    expect(
      computeDropTarget(four, x, DOC_HEIGHT / 2, 1, new Set(['m.pdf#p0', 'm.pdf#p1']), true),
    ).toEqual({ kind: 'into', docId: 'm', index: 1 });
  });

  it('falls back to between-slots when zoomed too far out', () => {
    // DOC_HEIGHT * scale below the 90px screen threshold
    const target = computeDropTarget(layout, 10, DOC_HEIGHT / 2, 0.1, null, true);
    expect(target.kind).toBe('between');
  });

  it('targets the gap between rows', () => {
    const gapY = DOC_HEIGHT + DOC_GAP_Y / 2;
    expect(computeDropTarget(layout, 10, gapY, 1, null, true)).toEqual({
      kind: 'between',
      docIndex: 1,
    });
    expect(computeDropTarget(layout, 10, -50, 1, null, true)).toEqual({
      kind: 'between',
      docIndex: 0,
    });
    const belowAll = layout.items[1].y + DOC_HEIGHT + DOC_GAP_Y / 2 + 1;
    expect(computeDropTarget(layout, 10, belowAll, 1, null, true)).toEqual({
      kind: 'between',
      docIndex: 2,
    });
  });

  it('never targets into when disallowed', () => {
    const target = computeDropTarget(layout, CARD_PAD_X + 1, DOC_HEIGHT / 2, 1, null, false);
    expect(target.kind).toBe('between');
  });

  it('maps world Y onto wrapped rows for the insertion index', () => {
    const letterW = pageDisplayWidth(...LETTER);
    const perRow = Math.floor((MAX_ROW_WIDTH + PAGE_GAP) / (letterW + PAGE_GAP));
    const pages = Array.from({ length: perRow + 2 }, () => LETTER);
    const wrapped = computeLayout([makeDoc('long', 'long.pdf', pages)]);
    const secondRowY = ROWS_TOP + BASE_PAGE_HEIGHT + ROW_GAP + BASE_PAGE_HEIGHT / 2;
    // Far left of the second row → insert before the first page of that row.
    expect(computeDropTarget(wrapped, CARD_PAD_X + 1, secondRowY, 1, null, true)).toEqual({
      kind: 'into',
      docId: 'long',
      index: perRow,
    });
    // Beyond the second row's last page → append.
    const rowEnd = CARD_PAD_X + 2 * (letterW + PAGE_GAP) + 10;
    expect(computeDropTarget(wrapped, rowEnd, secondRowY, 1, null, true)).toEqual({
      kind: 'into',
      docId: 'long',
      index: perRow + 2,
    });
  });
});

describe('wrapPages', () => {
  const letterW = pageDisplayWidth(...LETTER);
  const perRow = Math.floor((MAX_ROW_WIDTH + PAGE_GAP) / (letterW + PAGE_GAP));

  it('breaks greedily at MAX_ROW_WIDTH and never exceeds it', () => {
    const pages = makePages('a.pdf', Array.from({ length: perRow * 2 + 1 }, () => LETTER));
    const rows = wrapPages(pages, null);
    expect(rows.map((r) => r.length)).toEqual([perRow, perRow, 1]);
    expect(rows.every((r) => rowWidth(r) <= MAX_ROW_WIDTH)).toBe(true);
  });

  it('excludes the collapsed page(s) from wrapping, matching the DOM reflow', () => {
    const pages = makePages('a.pdf', Array.from({ length: perRow + 1 }, () => LETTER));
    expect(wrapPages(pages, null)).toHaveLength(2);
    // One excluded page drops the overflow row back to a single row.
    expect(wrapPages(pages, new Set([pages[0].id]))).toHaveLength(1);
    // A multi-page drag excludes every moving page at once.
    const many = makePages('a.pdf', Array.from({ length: perRow * 2 }, () => LETTER));
    const excludeTwo = new Set([many[0].id, many[1].id]);
    expect(wrapPages(many, excludeTwo).flat()).toHaveLength(perRow * 2 - 2);
  });

  it('yields a single empty row for a pageless document', () => {
    expect(wrapPages([], null)).toEqual([[]]);
  });
});

describe('docSize reserves the add-page ghost row (2n.3)', () => {
  const letterW = pageDisplayWidth(...LETTER);
  const perRow = Math.floor((MAX_ROW_WIDTH + PAGE_GAP) / (letterW + PAGE_GAP));

  it('reserves an extra row exactly when the trailing ghost cannot fit on the last page row', () => {
    const lastRowWidth = perRow * letterW + (perRow - 1) * PAGE_GAP;
    const ghostFits = lastRowWidth + PAGE_GAP + ADD_GHOST_WIDTH <= MAX_ROW_WIDTH;

    const full = computeLayout([
      makeDoc('a', 'a.pdf', Array.from({ length: perRow }, () => LETTER)),
    ]).items[0];
    const single = computeLayout([makeDoc('b', 'b.pdf', [LETTER])]).items[0];

    if (ghostFits) {
      expect(full.height).toBe(single.height); // ghost joins the full row — no extra row
    } else {
      // ghost wraps → the card reserves one more page row than a 1-page doc, so
      // the next card (positioned by this height) can't overlap it.
      expect(full.height).toBe(single.height + BASE_PAGE_HEIGHT + ROW_GAP);
    }
  });

  it('a two-page-row document is strictly taller than a single-page one', () => {
    const twoRows = computeLayout([
      makeDoc('a', 'a.pdf', Array.from({ length: perRow + 1 }, () => LETTER)),
    ]).items[0];
    const single = computeLayout([makeDoc('b', 'b.pdf', [LETTER])]).items[0];
    expect(twoRows.height).toBeGreaterThan(single.height);
  });
});

describe('betweenSlotY', () => {
  const layout = computeLayout([
    makeDoc('a', 'a.pdf', [LETTER]),
    makeDoc('b', 'b.pdf', [LETTER]),
  ]);

  it('returns the slot top for each index and appends after the last', () => {
    expect(betweenSlotY(layout, 0)).toBe(0);
    expect(betweenSlotY(layout, 1)).toBe(layout.items[1].y);
    expect(betweenSlotY(layout, 2)).toBe(layout.items[1].y + DOC_SLOT);
    expect(betweenSlotY(computeLayout([]), 0)).toBe(0);
  });
});
