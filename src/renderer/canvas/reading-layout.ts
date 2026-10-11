// Reading-view geometry: zoom fits, the responsive grid, paged slots and the
// cursor-anchored zoom. PURE, so every mapping is testable without a DOM.
//
// All offsets here are VIRTUAL document offsets (see `scrollMapFor` in
// reading-page.ts). Only DocumentView converts to real scroll space, at the
// DOM write.
//
// Every page renders at the same height (`READING_BASE_HEIGHT * zoom`); widths
// follow aspect. A grid column is as wide as the widest page, so a column count
// is a function of the zoom and the pane width alone, never of which pages a
// row happens to hold.

import type { LayoutMode, ReadingPaneId, ScrollMode, ZoomMode } from '../lib/reading-view-types';
import {
  anchorHolds,
  clampScrollTop,
  clampZoom,
  currentPageFor,
  fitHeightZoom,
  fitWidthZoom,
  READING_BASE_HEIGHT,
  READING_PAGE_GAP,
  type JumpAnchor,
} from './reading-page';
import {
  coverActive,
  pagesInRow as pagesInRowOfColumns,
  rowCountOf,
  rowOfPage as rowOfPageInColumns,
} from './spread-layout';

/**
 * Breathing room the fits leave beside the content, and the margin the
 * content keeps when it is wider than the pane. Exactly double the 8px custom
 * scrollbar (styles.css): if a zoom change flips a scrollbar's visibility the
 * content can only come out narrower than the pane, never wider.
 */
export const FIT_WIDTH_GUTTER = 16;

/** Accumulated wheel distance (px) at a paged row edge that steps one row. */
export const WHEEL_STEP_THRESHOLD = 50;
/** After a wheel step, further deltas are ignored for this long (inertia). */
export const WHEEL_STEP_LOCK_MS = 250;
/** A pause longer than this between wheel events forgets the partial distance. */
export const WHEEL_STEP_IDLE_MS = 300;

// Absorbs the rounding of `(availW + gap) / (colW + gap)` when the zoom was
// solved for an exact column count (`zoomForColumns`): 1.9999999999 must read 2.
const COLUMN_EPS = 1e-9;

export interface GridInput {
  /** Each page's displayed width at zoom 1 (`displayWidthAt(page, READING_BASE_HEIGHT)`),
   * at its effective rotation, in document order. */
  pageWidthsAt1: readonly number[];
  /** The effective (already clamped) zoom. */
  zoom: number;
  layoutMode: LayoutMode;
  coverAlone: boolean;
  direction: 'l2r' | 'r2l';
  scrollMode: ScrollMode;
  /** The scroller's client box. */
  viewportW: number;
  viewportH: number;
  /** Linked split panes only (see `linkQuadGeometry`): the width the column
   * count solves against and the height a paged slot fills, shared by every
   * pane whose scroll offsets are mirrored, in place of this pane's own. */
  linked?: { availW: number; slotViewportH: number };
}

export interface GridGeometry {
  columns: number;
  /** Column pitch minus the gap: the widest page's width at this zoom. */
  colW: number;
  gap: number;
  pageH: number;
  /** Page plus gap. */
  rowH: number;
  /** The vertical extent a row owns: `rowH`, or at least the viewport when paged. */
  slotH: number;
  rowCount: number;
  blockW: number;
  /** Scrollable width: at least the viewport. */
  contentW: number;
  /** Scrollable height (virtual): `rowCount * slotH`. */
  contentH: number;
}

export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageHit {
  pageIndex: number;
  /** Position within the page as a fraction of its width/height. Unclamped:
   * a point in a gap or margin keeps its offset from the nearest page. */
  u: number;
  v: number;
}

export interface WheelStepState {
  acc: number;
  lockedUntil: number;
  /** Time of the previous event; an idle pause forgets `acc`. */
  lastAt?: number;
}

function finitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** The widest page's width at zoom 1; 0 for an empty document. */
export function widestOf(pageWidthsAt1: readonly number[]): number {
  let w = 0;
  for (const x of pageWidthsAt1) if (x > w) w = x;
  return w;
}

/** The space the fits solve against, from the scroller's client box. */
export function fitAvailable(viewportW: number, viewportH: number): { availW: number; availH: number } {
  return { availW: viewportW - FIT_WIDTH_GUTTER, availH: viewportH - 2 * READING_PAGE_GAP };
}

/**
 * How many columns fit: `floor((availW + gap) / (colW + gap))`, never below 1
 * and never above the page count. A document with no pages answers 1.
 */
export function columnsFor(availW: number, colW: number, gap: number, pageCount: number): number {
  if (pageCount <= 1) return 1;
  const pitch = colW + gap;
  if (!finitePositive(pitch) || !Number.isFinite(availW)) return 1;
  const fit = Math.floor((availW + gap) / pitch + COLUMN_EPS);
  return Math.max(1, Math.min(Math.floor(pageCount), fit));
}

export function gridGeometry(i: GridInput): GridGeometry {
  const n = i.pageWidthsAt1.length;
  const z = i.zoom;
  const colW = widestOf(i.pageWidthsAt1) * z;
  const gap = READING_PAGE_GAP * z;
  const availW = i.linked ? i.linked.availW : fitAvailable(i.viewportW, i.viewportH).availW;
  const columns = i.layoutMode === 'single' ? 1 : columnsFor(availW, colW, gap, n);
  const rowCount = rowCountOf(n, columns, i.coverAlone);
  const pageH = READING_BASE_HEIGHT * z;
  const rowH = pageH + gap;
  const slotH = i.scrollMode === 'paged' ? Math.max(rowH, slotViewportH(i)) : rowH;
  const blockW = columns * colW + (columns - 1) * gap;
  const contentW = Math.max(i.viewportW, blockW + FIT_WIDTH_GUTTER);
  return { columns, colW, gap, pageH, rowH, slotH, rowCount, blockW, contentW, contentH: rowCount * slotH };
}

/** The height a paged slot fills: the pane's own, or the linked one. */
function slotViewportH(i: GridInput): number {
  return i.linked ? i.linked.slotViewportH : i.viewportH;
}

/** The row a page (0-based) sits in under this geometry. */
export function rowOfPage(g: GridGeometry, pageIndex: number, coverAlone: boolean): number {
  return rowOfPageInColumns(pageIndex, g.columns, coverAlone);
}

/** The 0-based pages a row shows, in reading order. */
export function pagesInRowOf(g: GridGeometry, row: number, coverAlone: boolean, n: number): number[] {
  if (row >= g.rowCount) return [];
  return pagesInRowOfColumns(row, g.columns, coverAlone, n);
}

/** Top of a row's page band (virtual): the slot top, plus the centring offset
 * that puts a page shorter than the viewport in the middle of its paged slot. */
export function rowTop(g: GridGeometry, i: GridInput, row: number): number {
  const centring = i.scrollMode === 'paged' ? Math.max(0, (slotViewportH(i) - g.pageH) / 2) : 0;
  return row * g.slotH + centring;
}

/**
 * A page's box in document space (virtual). Columns centre as a block; each
 * page centres in its column; a partial row fills columns from the
 * reading-start side; right-to-left mirrors the column order; a cover alone
 * on row 0 centres on the content.
 */
export function pageRect(g: GridGeometry, i: GridInput, pageIndex: number): PageRect {
  const n = i.pageWidthsAt1.length;
  if (n === 0) return { left: 0, top: 0, width: 0, height: 0 };
  const idx = Math.min(n - 1, Math.max(0, Math.floor(pageIndex)));
  const width = (i.pageWidthsAt1[idx] ?? 0) * i.zoom;
  const r = rowOfPage(g, idx, i.coverAlone);
  const top = rowTop(g, i, r);
  if (r === 0 && coverActive(g.columns, i.coverAlone)) {
    return { left: (g.contentW - width) / 2, top, width, height: g.pageH };
  }
  const first = pagesInRowOfColumns(r, g.columns, i.coverAlone, n)[0] ?? idx;
  const k = idx - first;
  const slot = i.direction === 'r2l' ? g.columns - 1 - k : k;
  const blockLeft = (g.contentW - g.blockW) / 2;
  const cellLeft = blockLeft + slot * (g.colW + g.gap);
  return { left: cellLeft + (g.colW - width) / 2, top, width, height: g.pageH };
}

/**
 * Exact fit zoom for the sticky fit modes, clamped through `clampZoom`.
 * `widestW1` is the widest page at zoom 1, so Fit Width never lets any page
 * overflow and the fit does not change while scrolling. Returns 0 when the
 * pane is not measured yet (callers keep their previous zoom).
 */
export function fitZoom(
  mode: Exclude<ZoomMode, 'custom' | 'actual'>,
  availW: number,
  availH: number,
  widestW1: number,
): number {
  const w = fitWidthZoom(availW, widestW1);
  const h = fitHeightZoom(availH, READING_BASE_HEIGHT);
  let z: number;
  if (mode === 'fitWidth') z = w;
  else if (mode === 'fitHeight') z = h;
  else z = w > 0 && h > 0 ? Math.min(w, h) : 0;
  return z > 0 ? clampZoom(z, 1, widestW1) : 0;
}

/** The zoom at which exactly `n` columns of the widest page fill `availW`.
 * Returns 0 for degenerate input. */
export function zoomForColumns(n: number, availW: number, widestW1: number): number {
  const c = Math.floor(n);
  if (c < 1 || !finitePositive(availW) || !finitePositive(widestW1)) return 0;
  const z = availW / (c * widestW1 + (c - 1) * READING_PAGE_GAP);
  return clampZoom(z, 1, widestW1);
}

function verticalDistance(top: number, height: number, y: number): number {
  if (y < top) return top - y;
  if (y > top + height) return y - (top + height);
  return 0;
}

/**
 * The page under a document point: the page whose box holds it, else the
 * nearest page of the nearest row. Null for an empty document.
 */
export function hitTest(g: GridGeometry, i: GridInput, docX: number, docY: number): PageHit | null {
  const n = i.pageWidthsAt1.length;
  if (n === 0 || g.rowCount === 0) return null;
  const guess = g.slotH > 0 ? Math.floor(docY / g.slotH) : 0;
  let row = Math.min(g.rowCount - 1, Math.max(0, guess));
  let bestDist = Infinity;
  for (const r of [row - 1, row, row + 1]) {
    if (r < 0 || r >= g.rowCount) continue;
    const d = verticalDistance(rowTop(g, i, r), g.pageH, docY);
    if (d < bestDist) {
      bestDist = d;
      row = r;
    }
  }
  const pages = pagesInRowOf(g, row, i.coverAlone, n);
  let pick = pages[0];
  let pickDist = Infinity;
  for (const p of pages) {
    const rect = pageRect(g, i, p);
    const d =
      docX < rect.left ? rect.left - docX : docX > rect.left + rect.width ? docX - (rect.left + rect.width) : 0;
    if (d < pickDist) {
      pickDist = d;
      pick = p;
    }
  }
  const rect = pageRect(g, i, pick);
  return {
    pageIndex: pick,
    u: rect.width > 0 ? (docX - rect.left) / rect.width : 0.5,
    v: rect.height > 0 ? (docY - rect.top) / rect.height : 0.5,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/**
 * The scroll position (left, virtual top) that puts the hit point back under
 * `pointer` (scroller-relative) in the new geometry, clamped to the content.
 * Exact while the column count is unchanged; across a reflow the page under
 * the pointer stays under it.
 */
export function anchoredScroll(
  after: GridGeometry,
  afterInput: GridInput,
  hit: PageHit,
  pointer: { x: number; y: number },
  viewport: { w: number; h: number },
): { left: number; topVirtual: number } {
  const r = pageRect(after, afterInput, hit.pageIndex);
  return {
    left: clamp(r.left + hit.u * r.width - pointer.x, 0, after.contentW - viewport.w),
    topVirtual: clamp(r.top + hit.v * r.height - pointer.y, 0, after.contentH - viewport.h),
  };
}

/** The paged row whose slot holds the viewport centre. 0 for an empty document. */
export function pagedRowAt(g: GridGeometry, virtualTop: number, viewportH: number): number {
  if (g.rowCount <= 0 || !finitePositive(g.slotH)) return 0;
  const r = Math.floor((virtualTop + viewportH / 2) / g.slotH);
  return Math.min(g.rowCount - 1, Math.max(0, r));
}

/**
 * Wheel hysteresis at a paged row edge. Deltas accumulate in one direction;
 * reaching `WHEEL_STEP_THRESHOLD` steps one row and ignores further deltas
 * for `WHEEL_STEP_LOCK_MS`, so one flick of inertial scrolling moves one row.
 * A reversal or an idle pause restarts the accumulation.
 */
export function wheelStep(
  s: WheelStepState,
  deltaPx: number,
  now: number,
): { s: WheelStepState; step: -1 | 0 | 1 } {
  if (now < s.lockedUntil) return { s: { acc: 0, lockedUntil: s.lockedUntil, lastAt: now }, step: 0 };
  if (!Number.isFinite(deltaPx) || deltaPx === 0) {
    return { s: { acc: s.acc, lockedUntil: s.lockedUntil, lastAt: now }, step: 0 };
  }
  let acc = s.acc;
  if (s.lastAt !== undefined && now - s.lastAt > WHEEL_STEP_IDLE_MS) acc = 0;
  if (acc !== 0 && Math.sign(acc) !== Math.sign(deltaPx)) acc = 0;
  acc += deltaPx;
  if (Math.abs(acc) >= WHEEL_STEP_THRESHOLD) {
    return { s: { acc: 0, lockedUntil: now + WHEEL_STEP_LOCK_MS, lastAt: now }, step: acc > 0 ? 1 : -1 };
  }
  return { s: { acc, lockedUntil: s.lockedUntil, lastAt: now }, step: 0 };
}

/** Wheel delta in CSS px: line mode is 16px a line, page mode one viewport. */
export function wheelDeltaPx(delta: number, deltaMode: number, viewportH: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * viewportH;
  return delta;
}

/** Content wider than the pane by more than this opens a horizontal scrollbar;
 * the spacer and the fits share it, so they agree on when one exists. */
export const OVERFLOW_EPS = 0.5;

/**
 * The height the fits solve against. `fullH` is the pane's height WITHOUT a
 * horizontal scrollbar, so the answer does not depend on whether one is
 * showing: a fit whose page would overflow the width solves against the
 * height left beside the scrollbar it causes. Solving against the live client
 * height instead flips between the two answers on every resize tick in the
 * band of pane widths where only one of them overflows.
 */
export function fitAvailableHeight(
  fullH: number,
  viewportW: number,
  widestW1: number,
  scrollbarH: number,
): number {
  const availH = fullH - 2 * READING_PAGE_GAP;
  const z = fitHeightZoom(availH, READING_BASE_HEIGHT);
  if (z > 0 && widestW1 * z + FIT_WIDTH_GUTTER > viewportW + OVERFLOW_EPS) {
    return availH - Math.max(0, scrollbarH);
  }
  return availH;
}

/**
 * Where a paged move lands (virtual top), or null for an empty document.
 * `scrollBy` > 0 first scrolls by that much inside a row taller than the
 * viewport; 0 always steps. A step past the first or last row stays on that
 * row's near edge in the direction of travel: forward ends at its bottom,
 * back at its top. Stepping back into a tall row lands at its end. `eps` is
 * the slack (virtual px) for "already at the edge".
 */
export function pagedTarget(
  g: GridGeometry,
  virtualTop: number,
  viewportH: number,
  dir: -1 | 1 | 'home' | 'end',
  scrollBy: number,
  eps = 1,
): number | null {
  if (g.rowCount <= 0) return null;
  if (dir === 'home') return 0;
  if (dir === 'end') return (g.rowCount - 1) * g.slotH;
  const r = pagedRowAt(g, virtualTop, viewportH);
  const slotTop = r * g.slotH;
  const slotEnd = slotTop + Math.max(0, g.slotH - viewportH);
  if (scrollBy > 0 && dir > 0 && virtualTop < slotEnd - eps) return Math.min(slotEnd, virtualTop + scrollBy);
  if (scrollBy > 0 && dir < 0 && virtualTop > slotTop + eps) return Math.max(slotTop, virtualTop - scrollBy);
  const nr = Math.min(g.rowCount - 1, Math.max(0, r + dir));
  if (nr === r) return dir > 0 ? slotEnd : slotTop;
  return dir > 0 ? nr * g.slotH : nr * g.slotH + Math.max(0, g.slotH - viewportH);
}

/**
 * The 1-based page the view is on at `virtualTop`: the page a recorded jump
 * meant while the jump still holds (see JumpAnchor), else the leading page of
 * the current row — the row nearest the viewport centre when continuous, the
 * row whose slot holds the centre when paged. `anchored` says which answered,
 * so a caller can drop an anchor that no longer holds. 1 for an empty or
 * unmeasured view.
 */
export function pageInView(
  g: GridGeometry,
  i: GridInput,
  virtualTop: number,
  anchor: JumpAnchor | null,
  pageIdAtAnchorSlot: string | null | undefined,
): { page: number; anchored: boolean } {
  const n = i.pageWidthsAt1.length;
  const vh = i.viewportH;
  if (n === 0 || vh <= 0) return { page: 1, anchored: false };
  const mRows = {
    scrollTop: virtualTop,
    viewportH: vh,
    rowH: g.slotH,
    pageHeight: g.pageH,
    pageCount: g.rowCount,
    contentHeight: g.contentH,
  };
  // The anchor's bounds check needs the PAGE count: anchor.page is a page
  // number, which in a grid exceeds the row count.
  if (anchor && anchorHolds(anchor, { ...mRows, pageCount: n }, pageIdAtAnchorSlot)) {
    return { page: anchor.page, anchored: true };
  }
  const row =
    i.scrollMode === 'paged'
      ? pagedRowAt(g, clampScrollTop(virtualTop, g.contentH, vh), vh) + 1
      : currentPageFor(mRows);
  const pages = pagesInRowOf(g, row - 1, i.coverAlone, n);
  return { page: pages.length > 0 ? pages[0] + 1 : 1, anchored: false };
}

/** What a pane's own measurement gives the fits and the paged slot. */
export interface FitBasis {
  /** The width the fits and the column count solve against. */
  availW: number;
  /** The height the fits solve against (`fitAvailableHeight`). */
  availH: number;
  /** The scroller's client height. */
  viewportH: number;
}

/** The geometry a linked pane resolves against instead of its own. */
export interface LinkedGeometry {
  availW: number;
  availH: number;
  slotViewportH: number;
}

/** The quad's scroll links: a and b share a row (vertical scroll), a and c
 * share a column (horizontal scroll); d pairs with c and b. */
const QUAD_ROW: Readonly<Record<ReadingPaneId, 0 | 1>> = { a: 0, b: 0, c: 1, d: 1 };
const QUAD_COL: Readonly<Record<ReadingPaneId, 0 | 1>> = { a: 0, b: 1, c: 0, d: 1 };

/**
 * The scroll axes two quad panes mirror: `y` when they share a row, `x` when
 * they share a column. A pane shares both with itself and neither with its
 * diagonal.
 */
export function quadLinkAxes(from: ReadingPaneId, to: ReadingPaneId): { x: boolean; y: boolean } {
  return { x: QUAD_COL[from] === QUAD_COL[to], y: QUAD_ROW[from] === QUAD_ROW[to] };
}

/**
 * The resolved geometry every quad pane shares. The links copy raw scroll
 * offsets, which name the same document point only when the mirrored axis has
 * the same geometry in both panes; a dragged divider gives the panes unequal
 * boxes. So all four solve the fits and the column count against the
 * smallest pane (no pane overflows a fit), which makes the zoom and the row
 * mapping equal everywhere; a paged slot fills the shorter pane of its row,
 * the only panes that share vertical offsets. Null until all four panes have
 * a measured box.
 */
export function linkQuadGeometry(
  bases: Readonly<Partial<Record<ReadingPaneId, FitBasis>>>,
): Record<ReadingPaneId, LinkedGeometry> | null {
  const { a, b, c, d } = bases;
  if (!a || !b || !c || !d) return null;
  const all = [a, b, c, d];
  if (all.some((x) => !(x.availW > 0) || !(x.availH > 0) || !(x.viewportH > 0))) return null;
  const availW = Math.min(...all.map((x) => x.availW));
  const availH = Math.min(...all.map((x) => x.availH));
  const top = Math.min(a.viewportH, b.viewportH);
  const bottom = Math.min(c.viewportH, d.viewportH);
  return {
    a: { availW, availH, slotViewportH: top },
    b: { availW, availH, slotViewportH: top },
    c: { availW, availH, slotViewportH: bottom },
    d: { availW, availH, slotViewportH: bottom },
  };
}

/**
 * A stepper or wheel zoom from `base` by `factor`, bounded by `range` (see
 * `readingZoomRange`) and monotonic in the direction of the step. A fit is
 * not bounded by the range, so `base` can lie outside it: a zoom out from at
 * or below the floor, or a zoom in from at or above the ceiling, keeps
 * `base`, where a plain clamp would move the zoom against the step.
 */
export function steppedZoom(base: number, factor: number, range: { min: number; max: number }): number {
  if (!(factor > 0) || factor === 1) return base;
  if (factor < 1 && base <= range.min) return base;
  if (factor > 1 && base >= range.max) return base;
  return Math.min(range.max, Math.max(range.min, base * factor));
}

/**
 * The point a zoom anchors at when no pointer gives one. A linked quad pane
 * takes its row's shared height (`slotViewportH`), not its own client height:
 * a horizontal scrollbar shortens only the pane whose content overflows, and
 * row partners anchoring at different heights land on different vertical
 * offsets after the zoom. Column partners have equal client widths (the
 * vertical scrollbar gutter is always reserved).
 */
export function viewportCentre(
  clientW: number,
  clientH: number,
  linked?: LinkedGeometry | null,
): { x: number; y: number } {
  return { x: clientW / 2, y: (linked ? linked.slotViewportH : clientH) / 2 };
}

/**
 * Where a jump to a page lands (virtual top): a paged row at its slot; a
 * continuous row centred when it is shorter than `clientH`, else at its top.
 * Unclamped at the end of the content: the scroller clamps.
 */
export function jumpTop(g: GridGeometry, i: GridInput, pageIndex: number, clientH: number): number {
  const slotTop = rowOfPage(g, pageIndex, i.coverAlone) * g.slotH;
  if (i.scrollMode === 'paged') return slotTop;
  return Math.max(0, slotTop - Math.max(0, (clientH - g.pageH) / 2));
}
