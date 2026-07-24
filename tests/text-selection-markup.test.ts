import { describe, expect, it } from 'vitest';
import {
  buildTextMarkupAnnotations,
  quadFromRect,
  quadsBBox,
  unprojectQuads,
  type PageBox,
  type RectLike,
} from '../src/renderer/lib/text-selection-markup';

// A 200x400 page at viewport (100,50) — line boxes below are in its space.
const PAGE_RECT: RectLike = { left: 100, top: 50, right: 300, bottom: 450 };
const page = (pageId: string, rect: RectLike = PAGE_RECT): PageBox => ({
  docId: 'd1',
  pageId,
  rect,
});
const ids = (): (() => string) => {
  let n = 0;
  return () => `a${++n}`;
};

describe('quadFromRect', () => {
  it('normalizes a line box into the page 0..1 space', () => {
    // x: 100→300 over 200px; y: 50→450 over 400px.
    expect(quadFromRect({ left: 150, top: 90, right: 250, bottom: 110 }, PAGE_RECT)).toEqual([
      0.25, 0.1, 0.75, 0.15,
    ]);
  });

  it('clamps a line box that overhangs the raster', () => {
    const q = quadFromRect({ left: 80, top: 40, right: 320, bottom: 470 }, PAGE_RECT)!;
    expect(q).toEqual([0, 0, 1, 1]);
  });

  it('drops degenerate rects (a collapsed caret has no area)', () => {
    expect(quadFromRect({ left: 150, top: 90, right: 150, bottom: 110 }, PAGE_RECT)).toBeNull();
    expect(quadFromRect({ left: 150, top: 90, right: 250, bottom: 90 }, PAGE_RECT)).toBeNull();
  });
});

describe('quadsBBox', () => {
  it('spans every quad corner', () => {
    const box = quadsBBox([0.2, 0.1, 0.8, 0.15, 0.1, 0.2, 0.5, 0.25]);
    expect(box.x).toBe(0.1);
    expect(box.y).toBe(0.1);
    expect(box.w).toBeCloseTo(0.7, 10);
    expect(box.h).toBeCloseTo(0.15, 10);
  });

  it('is empty for no quads', () => {
    expect(quadsBBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('unprojectQuads', () => {
  it('re-orders corners after rotating, so extents stay positive', () => {
    // Under a quarter turn the old top-left is no longer the smaller pair; the
    // commit builder reads width as x1-x0, so an un-ordered quad would export
    // with a NEGATIVE width.
    const out = unprojectQuads([0.25, 0.1, 0.75, 0.15], 90);
    expect(out).toHaveLength(4);
    expect(out[2]).toBeGreaterThan(out[0]);
    expect(out[3]).toBeGreaterThan(out[1]);
  });

  it('is identity at 0', () => {
    const q = [0.25, 0.1, 0.75, 0.15];
    expect(unprojectQuads(q, 0)).toBe(q);
  });
});

describe('buildTextMarkupAnnotations', () => {
  const rects: RectLike[] = [
    { left: 150, top: 90, right: 250, bottom: 110 }, // line 1
    { left: 120, top: 130, right: 200, bottom: 150 }, // line 2
  ];

  it('turns a selection into ONE annotation carrying a quad per line box', () => {
    const built = buildTextMarkupAnnotations({
      rects,
      pages: [page('p0')],
      markupType: 'highlight',
      color: '#ffe14d',
      newId: ids(),
    });
    expect(built).toHaveLength(1);
    const a = built[0].annotation;
    expect(built[0].pageId).toBe('p0');
    expect(a.kind).toBe('textmarkup');
    expect(a.markupType).toBe('highlight');
    expect(a.quads).toEqual([0.25, 0.1, 0.75, 0.15, 0.1, 0.2, 0.5, 0.25]);
    // The bbox spans both lines.
    expect({ x: a.x, y: a.y, w: a.w, h: a.h }).toEqual({ x: 0.1, y: 0.1, w: 0.65, h: 0.15 });
    expect(a.color).toBe('#ffe14d');
  });

  it('splits a selection that crosses a page break into one annotation PER page', () => {
    // The reading view is continuous — dragging across the gap is ordinary,
    // and no single annotation can span two pages.
    const second: RectLike = { left: 100, top: 500, right: 300, bottom: 520 };
    const built = buildTextMarkupAnnotations({
      rects: [...rects, second],
      pages: [page('p0'), page('p1', { left: 100, top: 470, right: 300, bottom: 870 })],
      markupType: 'underline',
      color: '#ff0000',
      newId: ids(),
    });
    expect(built.map((b) => b.pageId)).toEqual(['p0', 'p1']); // page order, not rect order
    expect(built[0].annotation.quads).toHaveLength(8);
    expect(built[1].annotation.quads).toEqual([0, 0.075, 1, 0.125]);
    expect(built.every((b) => b.annotation.markupType === 'underline')).toBe(true);
  });

  it('ignores rects that fall on no mounted page', () => {
    const built = buildTextMarkupAnnotations({
      rects: [{ left: 900, top: 900, right: 950, bottom: 920 }],
      pages: [page('p0')],
      markupType: 'highlight',
      color: '#ffe14d',
      newId: ids(),
    });
    expect(built).toEqual([]);
  });

  it('drops duplicate line boxes (a repeated quad double-darkens a highlight)', () => {
    const built = buildTextMarkupAnnotations({
      rects: [rects[0], { ...rects[0] }],
      pages: [page('p0')],
      markupType: 'highlight',
      color: '#ffe14d',
      newId: ids(),
    });
    expect(built[0].annotation.quads).toEqual([0.25, 0.1, 0.75, 0.15]);
  });

  it('stores quads un-projected when the view is rotated', () => {
    const built = buildTextMarkupAnnotations({
      rects: [rects[0]],
      pages: [page('p0')],
      markupType: 'strikeout',
      color: '#ffe14d',
      viewRotation: 90,
      newId: ids(),
    });
    const a = built[0].annotation;
    expect(a.quads).not.toEqual([0.25, 0.1, 0.75, 0.15]); // captured in the DISPLAY frame
    // Round-tripping through the view rotation returns the displayed quad.
    expect(unprojectQuads(a.quads!, 90)).toEqual([0.25, 0.1, 0.75, 0.15]);
    // And the stored bbox is derived from the stored quads, not the display ones.
    expect({ x: a.x, y: a.y, w: a.w, h: a.h }).toEqual(quadsBBox(a.quads!));
  });
});
