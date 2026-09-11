import { describe, it, expect } from 'vitest';
import {
  addColumn,
  captureExportRequest,
  columnFractionAt,
  currentRotation,
  exportRegions,
  moveColumn,
  moveRegionBounds,
  ownedAcceptedRegions,
  placeColumn,
  placeRow,
  prunedRegions,
  regionsFromDetection,
  removeColumn,
  selectionState,
  sessionMatches,
  setAcceptedAll,
  toggleRegion,
  type DetectedTable,
  type TableDetectionResult,
  type TableRegion,
  type TableReviewSession,
} from '../src/renderer/lib/table-review';

const DETECTED: DetectedTable = {
  page: 1,
  index: 0,
  bounds: [100, 500, 300, 700],
  columns: [100, 150, 200, 250],
  rows: [680, 640, 600],
  evidence: 'ruled',
  caption: 'Regional revenue',
  cells: 12,
};

function detection(regions: DetectedTable[]): TableDetectionResult {
  return { pages: [1], regions, untabled: {}, vertical_writing_runs: 0 };
}

function build(overrides: Partial<TableRegion> = {}): TableRegion {
  const { regions } = regionsFromDetection(
    detection([DETECTED]),
    'C:/doc.pdf',
    () => ({
      pageId: 'C:/doc.pdf#g1#p0',
      rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
      rotationAtDraw: 0,
      totalRotationAtDraw: 0,
    }),
    () => 'r1',
  );
  return { ...regions[0], ...overrides };
}

describe('reading a detection', () => {
  it('measures the interior lines against the user-space bounds', () => {
    const region = build();
    expect(region.columns).toEqual([0, 0.25, 0.5, 0.75]);
    // Rows measure DOWN from the top, so the first entry is the top row
    // whichever way the page is turned.
    expect(region.rows).toEqual([0.1, 0.3, 0.5]);
  });

  it('accepts nothing until the reviewer does', () => {
    expect(build().accepted).toBe(false);
    expect(selectionState([build()])).toBe('none');
  });

  it('counts a region whose page it cannot place instead of guessing one', () => {
    const { regions, skipped } = regionsFromDetection(
      detection([DETECTED, { ...DETECTED, index: 1 }]),
      'C:/doc.pdf',
      (row) =>
        row.index === 0
          ? {
              pageId: 'p',
              rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
              rotationAtDraw: 0,
              totalRotationAtDraw: 0,
            }
          : null,
      () => 'r',
    );
    expect([regions.length, skipped]).toEqual([1, 1]);
  });

  it('drops a region whose bounds enclose nothing', () => {
    const { regions, skipped } = regionsFromDetection(
      detection([{ ...DETECTED, bounds: [100, 500, 100, 700] }]),
      'C:/doc.pdf',
      () => ({
        pageId: 'p',
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
        rotationAtDraw: 0,
        totalRotationAtDraw: 0,
      }),
      () => 'r',
    );
    expect([regions.length, skipped]).toEqual([0, 1]);
  });
});

describe('which way an interior line is drawn', () => {
  it('turns a column into a row and back with the page', () => {
    expect(placeColumn(0.25, 0)).toEqual({ axis: 'x', at: 0.25 });
    expect(placeColumn(0.25, 90)).toEqual({ axis: 'y', at: 0.25 });
    expect(placeColumn(0.25, 180)).toEqual({ axis: 'x', at: 0.75 });
    expect(placeColumn(0.25, 270)).toEqual({ axis: 'y', at: 0.75 });
  });

  it('places a row on the axis a column is not on', () => {
    for (const rotation of [0, 90, 180, 270]) {
      expect(placeRow(0.25, rotation).axis).not.toBe(placeColumn(0.25, rotation).axis);
    }
  });

  it('reads a dragged position back as the fraction the export writes', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const drawn = placeColumn(0.37, rotation);
      expect(columnFractionAt(drawn.at, rotation)).toBeCloseTo(0.37, 10);
    }
  });

  it('moves the drawing rotation by however far the page turned since', () => {
    const region = build({ rotationAtDraw: 90, totalRotationAtDraw: 180 });
    expect(currentRotation(region, 90)).toBe(180);
    expect(currentRotation(region, 180)).toBe(270);
    expect(currentRotation(region, 0)).toBe(90);
  });
});

describe('adjusting a table', () => {
  it('carries the interior boundaries when the bounds move', () => {
    const region = build();
    const moved = moveRegionBounds([region], 'r1', { x: 0.2, y: 0.2, w: 0.6, h: 0.3 });
    expect(moved[0].columns).toEqual(region.columns);
    expect(moved[0].rect).toEqual({ x: 0.2, y: 0.2, w: 0.6, h: 0.3 });
  });

  it('clamps bounds inside the page', () => {
    const moved = moveRegionBounds([build()], 'r1', { x: 0.9, y: -0.5, w: 0.4, h: 0.4 });
    expect(moved[0].rect).toEqual({ x: 0.6, y: 0, w: 0.4, h: 0.4 });
  });

  it('will not let a boundary cross or meet its neighbour', () => {
    const region = build();
    // Columns are [0, 0.25, 0.5, 0.75]; dragging the middle one far right
    // stops short of the one after it.
    const pushed = moveColumn([region], 'r1', 2, 0.99);
    expect(pushed[0].columns[2]).toBeCloseTo(0.73, 10);
    const pulled = moveColumn([region], 'r1', 2, -1);
    expect(pulled[0].columns[2]).toBeCloseTo(0.27, 10);
    expect(pulled[0].columns[1]).toBe(0.25);
  });

  it('adds a boundary where the gesture put it, or not at all', () => {
    const region = build();
    expect(addColumn([region], 'r1', 0.6)[0].columns).toEqual([0, 0.25, 0.5, 0.6, 0.75]);
    // On top of an existing boundary: refused rather than nudged aside.
    expect(addColumn([region], 'r1', 0.505)[0].columns).toEqual(region.columns);
    expect(addColumn([region], 'r1', 1.2)[0].columns).toEqual(region.columns);
  });

  it('never removes the leading edge and never drops below two boundaries', () => {
    const region = build();
    expect(removeColumn([region], 'r1', 0)[0].columns).toEqual(region.columns);
    expect(removeColumn([region], 'r1', 2)[0].columns).toEqual([0, 0.25, 0.75]);
    const pair = build({ columns: [0, 0.5] });
    expect(removeColumn([pair], 'r1', 1)[0].columns).toEqual([0, 0.5]);
  });

  it('leaves every other table alone', () => {
    const a = build();
    const b = build({ id: 'r2' });
    expect(moveColumn([a, b], 'r1', 1, 0.4)[1]).toBe(b);
    expect(toggleRegion([a, b], 'r1')[1]).toBe(b);
  });
});

describe('the accepted set', () => {
  it('reports its own state', () => {
    const a = build();
    const b = build({ id: 'r2' });
    expect(selectionState(toggleRegion([a, b], 'r1'))).toBe('some');
    expect(selectionState(setAcceptedAll([a, b], true))).toBe('all');
    expect(selectionState([])).toBe('none');
  });

  it('exports only accepted tables, with columns back in user space', () => {
    const accepted = setAcceptedAll([build()], true);
    const { regions, skipped } = exportRegions(accepted, () => ({
      page: 3,
      bounds: [100, 500, 300, 700],
    }));
    expect(skipped).toBe(0);
    expect(regions).toEqual([
      {
        page: 3,
        bounds: [100, 500, 300, 700],
        columns: [100, 150, 200, 250],
        caption: 'Regional revenue',
      },
    ]);
  });

  it('round-trips a detection that was accepted unchanged', () => {
    const accepted = setAcceptedAll([build()], true);
    const { regions } = exportRegions(accepted, () => ({
      page: DETECTED.page,
      bounds: DETECTED.bounds,
    }));
    expect(regions[0].columns).toEqual(DETECTED.columns);
  });

  it('counts a table it cannot resolve rather than dropping it', () => {
    const accepted = setAcceptedAll([build()], true);
    expect(exportRegions(accepted, () => null)).toEqual({ regions: [], skipped: 1 });
  });

  it('exports nothing when nothing was accepted', () => {
    expect(exportRegions([build()], () => ({ page: 1, bounds: [0, 0, 1, 1] })).regions)
      .toEqual([]);
  });
});

describe('stale pages', () => {
  it('drops a table whose page is gone', () => {
    const region = build();
    expect(prunedRegions([region], new Set(['other']))).toEqual([]);
    expect(prunedRegions([region], new Set([region.pageId]))).toEqual([region]);
  });
});

describe('the revision a review belongs to', () => {
  const buffer = new Uint8Array([1]);
  const session: TableReviewSession = { path: 'C:/doc.pdf', workingPath: 'work.pdf', buffer };

  it('matches the exact working copy and buffer object, nothing looser', () => {
    expect(sessionMatches(session, { workingPath: 'work.pdf', buffer })).toBe(true);
    expect(sessionMatches(session, { workingPath: 'work.pdf', buffer: new Uint8Array([1]) })).toBe(false);
    expect(sessionMatches(session, { workingPath: 'work-reopened.pdf', buffer })).toBe(false);
    expect(sessionMatches(session, { workingPath: 'work.pdf', buffer: null })).toBe(false);
    expect(sessionMatches(session, undefined)).toBe(false);
    expect(sessionMatches(null, { workingPath: 'work.pdf', buffer })).toBe(false);
  });

  it('captures exactly the accepted tables of the session document, before any await', () => {
    const mine = setAcceptedAll([build(), build({ id: 'r2' })], true);
    const rejected = build({ id: 'r3' });
    const other = build({ id: 'r4', path: 'C:/other.pdf', accepted: true });
    expect(captureExportRequest(session, [...mine, rejected, other])).toEqual({
      session,
      regionIds: ['r1', 'r2'],
    });
    expect(captureExportRequest(session, [rejected])).toBeNull();
    expect(captureExportRequest(null, mine)).toBeNull();
  });

  it('exports the requested tables when the live set is still the same revision', () => {
    const live = setAcceptedAll([build(), build({ id: 'r2' })], true);
    const request = captureExportRequest(session, live)!;
    expect(ownedAcceptedRegions(request, { session, regions: live })).toEqual({ ok: true, regions: live });
  });

  it.each([
    ['moved buffer', { ...session, buffer: new Uint8Array([2]) }],
    ['reopened working copy', { ...session, workingPath: 'work-reopened.pdf' }],
    ['another document', { ...session, path: 'C:/other.pdf' }],
    ['no review at all', null],
  ] as const)('refuses a request whose revision is not the live one: %s', (_label, liveSession) => {
    const live = setAcceptedAll([build()], true);
    const request = captureExportRequest(session, live)!;
    expect(ownedAcceptedRegions(request, { session: liveSession, regions: live }))
      .toEqual({ ok: false, reason: 'stale-session' });
  });

  it('refuses a table the live set no longer holds', () => {
    const live = setAcceptedAll([build()], true);
    const request = { session, regionIds: ['r1', 'gone'] };
    expect(ownedAcceptedRegions(request, { session, regions: live }))
      .toEqual({ ok: false, reason: 'missing-region' });
  });

  it('refuses a table that was unchecked after the request was captured', () => {
    const live = setAcceptedAll([build()], true);
    const request = captureExportRequest(session, live)!;
    expect(ownedAcceptedRegions(request, { session, regions: toggleRegion(live, 'r1') }))
      .toEqual({ ok: false, reason: 'not-accepted' });
  });

  it('refuses a table that belongs to another document', () => {
    const foreign = build({ path: 'C:/other.pdf', accepted: true });
    const request = { session, regionIds: ['r1'] };
    expect(ownedAcceptedRegions(request, { session, regions: [foreign] }))
      .toEqual({ ok: false, reason: 'foreign-region' });
  });

  it('refuses an empty request rather than exporting whatever is checked now', () => {
    const live = setAcceptedAll([build()], true);
    expect(ownedAcceptedRegions({ session, regionIds: [] }, { session, regions: live }))
      .toEqual({ ok: false, reason: 'nothing-accepted' });
  });
});
