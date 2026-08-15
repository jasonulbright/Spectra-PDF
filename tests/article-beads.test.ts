// The article-bead band math and the canvas→panel channel. There is no DOM
// test environment, so the arithmetic lives in a module and the module is what
// gets pinned — the crop-draw discipline, one derivation over.
import { describe, it, expect, beforeEach } from 'vitest';
import { pageRectFromBand } from '../src/renderer/lib/crop-draw';
import {
  consumeDrawnBead,
  emptyArticle,
  moveBead,
  publishDrawnBead,
  stepBead,
  subscribeDrawnBead,
  __resetDrawnBead,
} from '../src/renderer/lib/article-beads';
import { pagesParam } from '../src/renderer/lib/page-scope';

const VIEW = [0, 0, 400, 600] as const;

describe('pageRectFromBand', () => {
  it('maps an unrotated band to page space with y flipped', () => {
    // Top-left quarter of the page: x 0..0.5, y 0..0.5 from the TOP.
    expect(pageRectFromBand({ x: 0, y: 0, w: 0.5, h: 0.5 }, VIEW)).toEqual([0, 300, 200, 600]);
  });

  it('keeps a centred band centred', () => {
    expect(pageRectFromBand({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, VIEW)).toEqual([
      100, 150, 300, 450,
    ]);
  });

  it('turns with the page at all four rotations', () => {
    // The band is always the top-left quarter of what the user SEES; the four
    // answers are the four page corners that quarter came from, which is the
    // whole point of tracking the rotation at draw time.
    const band = { x: 0, y: 0, w: 0.5, h: 0.5 };
    // 0°: the page's own top-left.
    expect(pageRectFromBand(band, VIEW, 0)).toEqual([0, 300, 200, 600]);
    // 90° clockwise for display: the page's left edge shows along the top, so
    // the displayed top-left quarter is the page's BOTTOM-left.
    expect(pageRectFromBand(band, VIEW, 90)).toEqual([0, 0, 200, 300]);
    // 180°: bottom-right.
    expect(pageRectFromBand(band, VIEW, 180)).toEqual([200, 0, 400, 300]);
    // 270°: the page's right edge shows along the top — the top-right corner.
    expect(pageRectFromBand(band, VIEW, 270)).toEqual([200, 300, 400, 600]);
  });

  it('adds the view box origin back, so a shifted crop box is honoured', () => {
    expect(pageRectFromBand({ x: 0, y: 0, w: 0.5, h: 0.5 }, [10, 20, 410, 620])).toEqual([
      10, 320, 210, 620,
    ]);
  });

  it('refuses a band with no area — a click is not a box', () => {
    expect(pageRectFromBand({ x: 0.5, y: 0.5, w: 0, h: 0 }, VIEW)).toBeNull();
    expect(pageRectFromBand({ x: 0.5, y: 0.5, w: 0.0005, h: 0.4 }, VIEW)).toBeNull();
  });

  it('refuses a degenerate page box', () => {
    expect(pageRectFromBand({ x: 0, y: 0, w: 1, h: 1 }, [0, 0, 0, 600])).toBeNull();
  });
});

describe('bead list edits', () => {
  const beads = [
    { page: 1, rect: [0, 0, 1, 1] as [number, number, number, number] },
    { page: 2, rect: [0, 0, 2, 2] as [number, number, number, number] },
    { page: 3, rect: [0, 0, 3, 3] as [number, number, number, number] },
  ];

  it('moves a bead within the order', () => {
    expect(moveBead(beads, 0, 1).map((b) => b.page)).toEqual([2, 1, 3]);
    expect(moveBead(beads, 2, -1).map((b) => b.page)).toEqual([1, 3, 2]);
  });

  it('returns the same array when the move falls off an end', () => {
    expect(moveBead(beads, 0, -1)).toBe(beads);
    expect(moveBead(beads, 2, 1)).toBe(beads);
    expect(moveBead(beads, 9, 1)).toBe(beads);
  });

  it('walks the thread as a circle, because a thread IS one', () => {
    expect(stepBead(3, 2, 1)).toBe(0);
    expect(stepBead(3, 0, -1)).toBe(2);
    expect(stepBead(0, 0, 1)).toBe(0);
  });

  it('starts an article with a title and nothing else', () => {
    expect(emptyArticle('Feature')).toEqual({
      title: 'Feature',
      author: '',
      subject: '',
      keywords: '',
      beads: [],
    });
  });
});

describe('the drawn-bead channel', () => {
  beforeEach(() => __resetDrawnBead());

  it('delivers to a live subscriber', () => {
    const seen: number[] = [];
    const off = subscribeDrawnBead((b) => seen.push(b.page));
    publishDrawnBead({ page: 4, rect: [0, 0, 1, 1], path: 'C:/a.pdf' });
    expect(seen).toEqual([4]);
    off();
    publishDrawnBead({ page: 5, rect: [0, 0, 1, 1], path: 'C:/a.pdf' });
    expect(seen).toEqual([4]);
  });

  it('consumes once — a remount must not re-append a box the user already has', () => {
    publishDrawnBead({ page: 2, rect: [0, 0, 1, 1], path: 'C:/a.pdf' });
    expect(consumeDrawnBead()?.page).toBe(2);
    expect(consumeDrawnBead()).toBeNull();
  });

  it('carries the document the band was drawn against', () => {
    publishDrawnBead({ page: 1, rect: [0, 0, 1, 1], path: 'C:/only.pdf' });
    expect(consumeDrawnBead()?.path).toBe('C:/only.pdf');
  });
});

describe('pagesParam', () => {
  it('reads a blank or "all" field as every page', () => {
    expect(pagesParam('')).toBe('all');
    expect(pagesParam('all')).toBe('all');
    expect(pagesParam('ALL')).toBe('all');
    expect(pagesParam(undefined)).toBe('all');
  });

  it('reads a list as 1-based numbers', () => {
    expect(pagesParam('1,3,5')).toEqual([1, 3, 5]);
    expect(pagesParam(' 2 , 4 ')).toEqual([2, 4]);
  });

  it('drops what is not a page rather than sending it to the engine', () => {
    expect(pagesParam('1,x,0,-2,3')).toEqual([1, 3]);
    expect(pagesParam('x')).toBe('all');
  });
});
