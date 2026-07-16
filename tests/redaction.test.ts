import { describe, expect, it } from 'vitest';
import {
  buildRedactionRegions,
  projectMarkRect,
  rotateNormalizedPoint,
  rotateNormalizedPoints,
  rotateNormalizedRect,
} from '../src/renderer/lib/redaction';
import type { PageGeometry, RedactionMark } from '../src/renderer/lib/redaction';
import { workspacePageNumber } from '../src/renderer/lib/workspace-commit';
import { displayRectToPdf } from '../src/renderer/lib/pdfx-build';
import { rotateAnnotationRect } from '../src/renderer/state/reducer';
import type { OpenDocument, PageAnnotation, PageRef } from '../src/renderer/state/types';

function pageRef(path: string, index: number, rotation: 0 | 90 | 180 | 270 = 0): PageRef {
  return {
    id: `${path}#p${index}`,
    sourceDocId: path,
    sourcePageIndex: index,
    rotation,
    width: 612,
    height: 792,
  };
}

function makeDoc(id: string, path: string, pages: PageRef[]): OpenDocument {
  return {
    id,
    path,
    workingPath: `${path}.working`,
    name: id,
    pageCount: pages.length,
    buffer: null,
    dirty: false,
    undoStack: [],
    redoStack: [],
    pages,
  };
}

function mark(
  pageId: string,
  path: string,
  rect: { x: number; y: number; w: number; h: number },
  rotationAtDraw: 0 | 90 | 180 | 270 = 0,
  id = `mark-${pageId}-${rotationAtDraw}`,
): RedactionMark {
  return { id, path, pageId, rect, rotationAtDraw };
}

const LETTER: PageGeometry = { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 };

function geometryStub(byPageId: Record<string, PageGeometry> = {}) {
  return async (page: PageRef): Promise<PageGeometry> => byPageId[page.id] ?? LETTER;
}

function expectRectClose(actual: [number, number, number, number], expected: number[]): void {
  for (let i = 0; i < 4; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
}

describe('rotateNormalizedRect', () => {
  const rects = [
    { x: 0.1, y: 0.2, w: 0.3, h: 0.15 },
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0.7, y: 0.05, w: 0.25, h: 0.6 },
  ];

  it('matches the reducer’s rotateAnnotationRect case for case (they must never drift)', () => {
    for (const r of rects) {
      for (const delta of [0, 90, 180, 270, -90, 450]) {
        const viaAnnotation = rotateAnnotationRect(
          { id: 'a', kind: 'highlight', color: '#fff', ...r } as PageAnnotation,
          delta,
        );
        const viaRect = rotateNormalizedRect(r, delta);
        expect(viaRect.x).toBeCloseTo(viaAnnotation.x, 12);
        expect(viaRect.y).toBeCloseTo(viaAnnotation.y, 12);
        expect(viaRect.w).toBeCloseTo(viaAnnotation.w, 12);
        expect(viaRect.h).toBeCloseTo(viaAnnotation.h, 12);
      }
    }
  });

  it('four quarter turns compose to the identity', () => {
    for (const r of rects) {
      let out = r;
      for (let i = 0; i < 4; i++) out = rotateNormalizedRect(out, 90);
      expect(out.x).toBeCloseTo(r.x, 12);
      expect(out.y).toBeCloseTo(r.y, 12);
      expect(out.w).toBeCloseTo(r.w, 12);
      expect(out.h).toBeCloseTo(r.h, 12);
    }
  });
});

describe('projectMarkRect', () => {
  it('is the identity while the page keeps the rotation it was drawn at', () => {
    const m = mark('p', 'f.pdf', { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, 90);
    expect(projectMarkRect(m, 90)).toEqual(m.rect);
  });

  it('re-projects by the rotation delta since draw', () => {
    const m = mark('p', 'f.pdf', { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, 0);
    expect(projectMarkRect(m, 90)).toEqual(rotateNormalizedRect(m.rect, 90));
    // 0 drawn, page now at 270 — equivalent to -90 from draw orientation.
    expect(projectMarkRect(m, 270)).toEqual(rotateNormalizedRect(m.rect, 270));
    // drawn at 270, page back at 0 — delta wraps negative.
    const m2 = mark('p', 'f.pdf', { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, 270);
    expect(projectMarkRect(m2, 0)).toEqual(rotateNormalizedRect(m2.rect, 90));
  });
});

describe('workspacePageNumber', () => {
  it('counts across same-path sibling documents in workspace order', () => {
    const docA = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0), pageRef('f.pdf', 1)]);
    const docB = makeDoc('b', 'f.pdf', [pageRef('f.pdf', 2), pageRef('f.pdf', 3)]);
    const other = makeDoc('x', 'other.pdf', [pageRef('other.pdf', 0)]);
    const docs = [docA, other, docB];
    expect(workspacePageNumber(docs, docA, 'f.pdf#p1')).toBe(2);
    expect(workspacePageNumber(docs, docB, 'f.pdf#p2')).toBe(3);
    expect(workspacePageNumber(docs, other, 'other.pdf#p0')).toBe(1);
    expect(workspacePageNumber(docs, docA, 'missing')).toBeNull();
  });
});

describe('buildRedactionRegions', () => {
  it('converts an unrotated mark into the page’s PDF point space', async () => {
    const doc = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0)]);
    const m = mark('f.pdf#p0', 'f.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const { files, skippedMarkIds } = await buildRedactionRegions([doc], [m], geometryStub());
    expect(skippedMarkIds).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('f.pdf');
    expect(files[0].markIds).toEqual([m.id]);
    expect(files[0].regions).toHaveLength(1);
    expect(files[0].regions[0].page).toBe(1);
    // Top-left display origin maps to top of the PDF page: y flips.
    expectRectClose(files[0].regions[0].rect, [61.2, 633.6, 183.6, 712.8]);
  });

  it('accounts for a baked /Rotate the file already carries', async () => {
    const doc = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0)]);
    const m = mark('f.pdf#p0', 'f.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const { files } = await buildRedactionRegions(
      [doc],
      [m],
      geometryStub({ 'f.pdf#p0': { box: LETTER.box, bakedRotate: 90 } }),
    );
    // displayPointToPdf's 90° case: (u,v) → (v·W, u·H).
    expectRectClose(files[0].regions[0].rect, [61.2, 79.2, 122.4, 237.6]);
  });

  it('composes a pending in-memory rotation at draw time with the baked one', async () => {
    const doc = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0, 90)]);
    const m = mark('f.pdf#p0', 'f.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, 90);
    const { files } = await buildRedactionRegions(
      [doc],
      [m],
      geometryStub({ 'f.pdf#p0': { box: LETTER.box, bakedRotate: 90 } }),
    );
    // 90 baked + 90 drawn = 180: (u,v) → ((1−u)·W, v·H).
    expectRectClose(files[0].regions[0].rect, [428.4, 79.2, 550.8, 158.4]);
  });

  it('rotating a page after the mark was drawn does not move the region in user space', async () => {
    // Same physical box marked two ways: drawn at 0 (page later rotated to
    // 90), and drawn at 90 directly using the projected rect. Both must yield
    // the same PDF-space region — /Rotate never moves content.
    const rect0 = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    const drawnAt0 = mark('f.pdf#p0', 'f.pdf', rect0, 0, 'm0');
    const drawnAt90 = mark('f.pdf#p0', 'f.pdf', rotateNormalizedRect(rect0, 90), 90, 'm90');
    const doc = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0, 90)]); // current rotation: 90
    const { files } = await buildRedactionRegions([doc], [drawnAt0, drawnAt90], geometryStub());
    expect(files[0].regions).toHaveLength(2);
    expectRectClose(files[0].regions[1].rect, [...files[0].regions[0].rect]);
    // And the render-time projection agrees with what the direct draw sees.
    expect(projectMarkRect(drawnAt0, 90)).toEqual(drawnAt90.rect);
  });

  it('applies the crop box origin, matching the annotation builder’s box', async () => {
    const doc = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0)]);
    const m = mark('f.pdf#p0', 'f.pdf', { x: 0, y: 0, w: 1, h: 1 });
    const { files } = await buildRedactionRegions(
      [doc],
      [m],
      geometryStub({ 'f.pdf#p0': { box: { x: 10, y: 20, width: 600, height: 700 }, bakedRotate: 0 } }),
    );
    expectRectClose(files[0].regions[0].rect, [10, 20, 610, 720]);
    // Sanity: identical to converting through displayRectToPdf directly.
    expectRectClose(
      files[0].regions[0].rect,
      displayRectToPdf(m.rect, { x: 10, y: 20, width: 600, height: 700 }, 0),
    );
  });

  it('numbers pages across pdfx sibling documents of the same file', async () => {
    const docA = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0), pageRef('f.pdf', 1)]);
    const docB = makeDoc('b', 'f.pdf', [pageRef('f.pdf', 2)]);
    const m = mark('f.pdf#p2', 'f.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const { files } = await buildRedactionRegions([docA, docB], [m], geometryStub());
    expect(files).toHaveLength(1);
    expect(files[0].regions[0].page).toBe(3);
  });

  it('groups marks per file and keeps mark ids with their payload', async () => {
    const docA = makeDoc('a', 'a.pdf', [pageRef('a.pdf', 0)]);
    const docB = makeDoc('b', 'b.pdf', [pageRef('b.pdf', 0)]);
    const m1 = mark('a.pdf#p0', 'a.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, 0, 'm1');
    const m2 = mark('b.pdf#p0', 'b.pdf', { x: 0.2, y: 0.2, w: 0.2, h: 0.1 }, 0, 'm2');
    const m3 = mark('a.pdf#p0', 'a.pdf', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 0, 'm3');
    const { files } = await buildRedactionRegions([docA, docB], [m1, m2, m3], geometryStub());
    expect(files).toHaveLength(2);
    const a = files.find((f) => f.path === 'a.pdf')!;
    const b = files.find((f) => f.path === 'b.pdf')!;
    expect(a.markIds).toEqual(['m1', 'm3']);
    expect(a.regions).toHaveLength(2);
    expect(b.markIds).toEqual(['m2']);
  });

  it('follows a page moved to another document rather than trusting the draw-time path', async () => {
    // The page physically belongs to a.pdf's bytes but now sits in b.pdf's
    // workspace document (cross-file move, uncommitted). The commit gate will
    // materialize it INTO b.pdf, so the region must target b.pdf page 2.
    const moved = pageRef('a.pdf', 0);
    const docA = makeDoc('a', 'a.pdf', [pageRef('a.pdf', 1)]);
    const docB = makeDoc('b', 'b.pdf', [pageRef('b.pdf', 0), moved]);
    const m = mark(moved.id, 'a.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const { files } = await buildRedactionRegions([docA, docB], [m], geometryStub());
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('b.pdf');
    expect(files[0].regions[0].page).toBe(2);
  });

  it('skips marks whose page no longer exists instead of guessing', async () => {
    const doc = makeDoc('a', 'f.pdf', [pageRef('f.pdf', 0)]);
    const gone = mark('f.pdf#p9', 'f.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, 0, 'gone');
    const kept = mark('f.pdf#p0', 'f.pdf', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, 0, 'kept');
    const { files, skippedMarkIds } = await buildRedactionRegions([doc], [gone, kept], geometryStub());
    expect(skippedMarkIds).toEqual(['gone']);
    expect(files).toHaveLength(1);
    expect(files[0].markIds).toEqual(['kept']);
  });
});

describe('rotateNormalizedPoint(s) — the rect projector’s point twin (M6.1)', () => {
  it('matches rotateNormalizedRect on zero-size corners, every delta', () => {
    for (const d of [0, 90, 180, 270]) {
      for (const [x, y] of [[0, 0], [1, 1], [0.25, 0.7], [0.5, 0.5]]) {
        const viaRect = rotateNormalizedRect({ x, y, w: 0, h: 0 }, d);
        const viaPoint = rotateNormalizedPoint(x, y, d);
        expect(viaPoint.x).toBeCloseTo(viaRect.x, 12);
        expect(viaPoint.y).toBeCloseTo(viaRect.y, 12);
      }
    }
  });

  it('inverts cleanly: rotate then counter-rotate is identity', () => {
    for (const d of [90, 180, 270]) {
      const p = rotateNormalizedPoint(0.3, 0.8, d);
      const back = rotateNormalizedPoint(p.x, p.y, (360 - d) % 360);
      expect(back.x).toBeCloseTo(0.3, 12);
      expect(back.y).toBeCloseTo(0.8, 12);
    }
  });

  it('maps flat point lists pairwise', () => {
    expect(rotateNormalizedPoints([0.2, 0.4, 0.6, 0.9], 90)).toEqual([
      1 - 0.4, 0.2, 1 - 0.9, 0.6,
    ]);
    // delta 0 returns the same reference — the flat path costs nothing.
    const pts = [0.1, 0.2];
    expect(rotateNormalizedPoints(pts, 0)).toBe(pts);
  });
});
