// N11 slice B — ruler GUIDES. Pure model + math; the drag lives in the canvas
// components, the state in WorkspaceCanvasView.
//
// A guide is per-document view state, like a redaction mark: it is never written
// into the file, it invalidates
// on buffer identity, and it is bound to a generation-tagged page id. It
// carries `rotationAtDraw` and projects through it for the same reason a mark
// does — the page it is pinned to can turn under it, from Rotate View or from
// a pending page-tier rotation, and a guide that stayed put on screen while
// the paper turned would be measuring nothing.
import type { SnapGuide } from './snap';

export type GuideAxis = 'x' | 'y';

export interface PageGuide {
  id: string;
  /** The owning FILE — what buffer-identity invalidation is keyed on. */
  path: string;
  /** The generation-tagged page id (opaque; never parsed). */
  pageId: string;
  /** 'x' is a VERTICAL line at that normalized x; 'y' is horizontal. */
  axis: GuideAxis;
  /** Display-normalized position in the frame named by `rotationAtDraw`. */
  pos: number;
  rotationAtDraw: 0 | 90 | 180 | 270;
}

/**
 * A quarter-turn applied to a guide LINE.
 *
 * The point twin is `rotateNormalizedPoint` (redaction.ts) and this agrees
 * with it by construction: the line x = p is the set of points (p, t), and at
 * 90° that maps to (1 − t, p) — a HORIZONTAL line at y = p. So a quarter turn
 * swaps the axis, and which end the position is measured from flips on two of
 * the four turns. Unit-asserted against the point form.
 */
export function rotateGuide(
  guide: { axis: GuideAxis; pos: number },
  delta: number,
): { axis: GuideAxis; pos: number } {
  const d = (((delta % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  if (d === 0) return { axis: guide.axis, pos: guide.pos };
  if (guide.axis === 'x') {
    if (d === 90) return { axis: 'y', pos: guide.pos };
    if (d === 180) return { axis: 'x', pos: 1 - guide.pos };
    return { axis: 'y', pos: 1 - guide.pos }; // 270
  }
  if (d === 90) return { axis: 'x', pos: 1 - guide.pos };
  if (d === 180) return { axis: 'y', pos: 1 - guide.pos };
  return { axis: 'x', pos: guide.pos }; // 270
}

/** Where a guide should DRAW on a page whose effective rotation has changed
 * since it was dragged off the ruler — the `projectMarkRect` twin. */
export function projectGuide(
  guide: PageGuide,
  currentRotation: number,
): { axis: GuideAxis; pos: number } {
  return rotateGuide(guide, currentRotation - guide.rotationAtDraw);
}

/** The guides on one page, projected into the display frame. */
export function guidesOnPage(
  all: readonly PageGuide[],
  pageId: string,
  currentRotation: number,
): { id: string; axis: GuideAxis; pos: number }[] {
  const out: { id: string; axis: GuideAxis; pos: number }[] = [];
  for (const g of all) {
    if (g.pageId !== pageId) continue;
    const p = projectGuide(g, currentRotation);
    out.push({ id: g.id, axis: p.axis, pos: p.pos });
  }
  return out;
}

/** The snap-candidate form (`lib/snap.ts` owns what happens next). */
export function toSnapGuides(
  projected: readonly { axis: GuideAxis; pos: number }[],
): SnapGuide[] {
  return projected.map((g) => ({ axis: g.axis, pos: g.pos }));
}

/**
 * The guide under a pointer, or null.
 *
 * Tolerances are per axis and in NORMALIZED units because the caller already
 * holds the page's pixel size; passing pixels in would make this care about
 * the view. A tie goes to the CLOSER one, then to the later guide — the one
 * you most recently dragged is the one on top, which is where a click means to
 * land.
 */
export function guideAt(
  projected: readonly { id: string; axis: GuideAxis; pos: number }[],
  x: number,
  y: number,
  tolX: number,
  tolY: number,
): { id: string; axis: GuideAxis; pos: number } | null {
  let best: { g: { id: string; axis: GuideAxis; pos: number }; d: number } | null = null;
  for (const g of projected) {
    const d = g.axis === 'x' ? Math.abs(g.pos - x) / (tolX || 1) : Math.abs(g.pos - y) / (tolY || 1);
    const within = g.axis === 'x' ? Math.abs(g.pos - x) <= tolX : Math.abs(g.pos - y) <= tolY;
    if (!within) continue;
    if (!best || d <= best.d) best = { g, d };
  }
  return best ? best.g : null;
}

/** A guide dragged past the page edge is deleted. A
 * hair of slack so a guide parked exactly on the edge survives. */
export function isOffPage(pos: number): boolean {
  return !(pos >= -1e-6 && pos <= 1 + 1e-6);
}

/** Move one guide (display frame in, stored frame out — the caller un-projects
 * with `rotateGuide(…, −rotation)` first, exactly like annotation rects). */
export function withGuidePos(
  all: readonly PageGuide[],
  id: string,
  pos: number,
): PageGuide[] {
  return all.map((g) => (g.id === id ? { ...g, pos } : g));
}

export function withoutGuide(all: readonly PageGuide[], id: string): PageGuide[] {
  return all.filter((g) => g.id !== id);
}

/** Drop every guide belonging to a file whose bytes changed (the redaction-
 * mark invalidation, same call shape). */
export function withoutPaths(
  all: readonly PageGuide[],
  paths: ReadonlySet<string>,
): PageGuide[] {
  return all.filter((g) => !paths.has(g.path));
}

/** Drop every guide whose page no longer exists — the § F id-holder rule: a
 * generation-tagged id that is gone must never be offered to a gesture. */
export function prunedToPages(
  all: readonly PageGuide[],
  livePageIds: ReadonlySet<string>,
): PageGuide[] {
  return all.filter((g) => livePageIds.has(g.pageId));
}
