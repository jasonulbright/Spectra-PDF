// Which page is "current" in the reading view (Phase 4 M4.1b).
//
// Extracted as pure math because the tie-break is subtle and got this wrong
// once: every page that is FULLY visible overlaps the viewport by exactly
// `pageHeight`, so the moment two pages fit at once they all tie, and a bare
// `overlap > best` silently degrades to "topmost visible wins" — which reports
// N-1 after a mid-doc jump and reports the FIRST visible page when scrolled to
// the end. See tests/reading-page.test.ts.

export interface ReadingMetrics {
  /** Scroll offset of the reading pane, px. */
  scrollTop: number;
  /** Height of the scroll viewport, px. */
  viewportH: number;
  /** Per-page row pitch (page + gap), px. */
  rowH: number;
  /** Rendered page height, px (rowH minus the gap). */
  pageHeight: number;
  pageCount: number;
  /** Total scrollable content height, px (pageCount * rowH). */
  contentHeight: number;
}

/** Sub-pixel slack for "equally visible" — the values are zoom-scaled floats. */
const TIE_EPS = 0.5;

/**
 * A programmatic jump's intent, recorded by `centerOn`.
 *
 * Scroll position ALONE is ambiguous at the scroll extremes and cannot be made
 * unambiguous by any formula: "scrolled to the top" and "jumped to page 2 of a
 * pane showing pages 1-3" are the SAME scrollTop (centring page 2 wants a
 * negative offset, so it clamps to 0), yet must report 1 and 2 respectively.
 * Same at the end: jumping to page 49 of 50 saturates at maxScroll, which is
 * also where "scrolled to the bottom" (page 50) lands. So a jump records what
 * it MEANT, and that wins until the user scrolls away from it — which is how
 * the page box stops snapping back (review-caught, twice: first the tie-break,
 * then the boundary clamps that "fixed" it).
 *
 * DELIBERATELY BEST-EFFORT, and it fails SAFE: any reindex drops it. As shipped,
 * nothing about a page survives one — `lib/workspace.ts` re-derives every
 * PageRef from the new buffer and assigns BOTH `id` and `sourcePageIndex`
 * positionally. (`PageRef.id`'s "stable" only ever meant "survives a REORDER",
 * where the live reducers carry the same objects through.)
 *
 * For an engine-authored or external reindex that is also IRREDUCIBLE: the
 * renderer didn't author those bytes, so position can't be trusted (a reopened,
 * externally-edited file can re-compose the doc while scroll/zoom/pane all stay
 * equal) and content-fingerprint matching is the identity-model surgery
 * `18-phase3-polish.md` weighed and declined.
 *
 * For the JS page-tier COMMIT it is a COST decision, not an impossibility — be
 * honest about which (review-caught: the first draft of this note conflated
 * them). `workspace-commit.ts` `planCommit` builds the new file FROM the
 * pre-commit `PageRef[]`, 1:1 and in order, so the app does know the old-id →
 * new-position mapping at that moment; `COMMIT_PAGE_EDITS` simply doesn't carry
 * it, leaving identity to the blind positional formula. Threading it through is
 * bounded but lands page-identity plumbing in the most invariant-dense path in
 * the app (atomic multi-file commit, single in-flight run, the commit gate) and
 * would still need width/height + rotation reconciliation for baked rotations —
 * a poor trade for remembering ONE page-number readout. So: not done, and the
 * cost is bounded — a jump to a boundary-ADJACENT page (2, or N-1) stops being
 * remembered once you Save, and `currentPageFor`'s at-top/at-end answer takes
 * over. Revisit if a second consumer ever needs cross-commit page identity.
 */
export interface JumpAnchor {
  /** The scroll offset the jump actually LANDED on (post browser clamp). */
  scrollTop: number;
  /** 1-based page the jump meant. */
  page: number;
  /**
   * Identity of that page. A page-tier edit (delete/reorder/import) renumbers
   * pages WITHOUT remounting the reading view — `OpenDocument.id` is
   * `path#docIndex` and no page-tier reducer branch touches it — and can leave
   * the scroll offset untouched too (deleting the page at the top keeps
   * scrollTop 0). Layout and scroll therefore both still "match" while the page
   * under the viewport has silently become a different one, so the anchor also
   * pins WHICH page it meant (review-caught: a jump to page 2 followed by
   * deleting page 1 reported "2 / 49" while showing page 1).
   */
  pageId: string;
  /** Layout the anchor was taken under — a zoom/resize invalidates it. */
  rowH: number;
  viewportH: number;
}

/** Sub-pixel slack for "the view is still parked where the jump left it". */
const ANCHOR_EPS = 1;

/**
 * Clamp a scroll offset to what the pane can actually reach.
 *
 * `scrollTop` is React state fed by the scroll EVENT, but a page-tier edit
 * shrinks `pageCount`/`contentHeight` SYNCHRONOUSLY — so for one render the
 * offset can point past the end of the now-shorter content, before the browser
 * clamps the DOM and fires the corrective scroll event. EVERY consumer of
 * scrollTop must clamp, or it computes against a position that doesn't exist:
 * the readout named a page over a blank pane, and the virtualization window
 * produced `first > last` and rendered NOTHING (both review-caught, one round
 * apart — the second because only the readout was fixed the first time).
 */
export function clampScrollTop(scrollTop: number, contentHeight: number, viewportH: number): number {
  return Math.min(Math.max(0, scrollTop), Math.max(0, contentHeight - viewportH));
}

/**
 * Whether a recorded jump still describes the current view: same layout, the
 * page it meant is still the page sitting at that slot, and the user hasn't
 * scrolled away from where the jump landed.
 *
 * @param pageIdAtAnchorSlot id of the page currently at the anchor's 1-based
 *   `page` slot (i.e. `doc.pages[anchor.page - 1]?.id`). Fails CLOSED — an
 *   absent or different id means the composition moved under the anchor and the
 *   view must speak for itself again.
 */
export function anchorHolds(
  anchor: JumpAnchor | null | undefined,
  m: ReadingMetrics,
  pageIdAtAnchorSlot: string | null | undefined,
): boolean {
  if (!anchor) return false;
  if (anchor.page < 1 || anchor.page > m.pageCount) return false;
  if (!pageIdAtAnchorSlot || pageIdAtAnchorSlot !== anchor.pageId) return false;
  // Clamp here too — this module's rule is that EVERY consumer of scrollTop
  // clamps, so it enforces it internally rather than trusting callers. Without
  // it, deleting pages AFTER the anchored page (which leaves the anchor's slot
  // and identity intact) shrinks the content while the stale scrollTop still
  // matches `anchor.scrollTop` bit-for-bit — so the anchor wrongly HELD and
  // reported a page the pane was no longer showing (review-caught: the third
  // unclamped consumer, found two rounds after the first two were fixed).
  const scrollTop = clampScrollTop(m.scrollTop, m.contentHeight, m.viewportH);
  return (
    anchor.rowH === m.rowH &&
    anchor.viewportH === m.viewportH &&
    Math.abs(scrollTop - anchor.scrollTop) <= ANCHOR_EPS
  );
}

// The reading view's zoom range, shared by the stepper and the presets.
//
// Deliberately WIDE — roughly Acrobat's own 8%–6400% in spirit. It must be,
// because a preset computes a MEANINGFUL target and clamping is what makes it
// lie: the earlier [0.1, 6] range (sized for the +/- stepper around 1.0)
// silently broke Fit Width on any pane wider than ~4459px (a maximized 5K /
// ultrawide) and Actual Size on any page under 96pt — a 2×1in label or ID card
// rendered at ~133% while the command claimed "Actual Size" (review-caught).
// The stepper and the presets MUST share one range: a preset that could exceed
// the stepper's ceiling would make the next Ctrl+= zoom *out*.
//
// Wide is cheap here because the raster is budget-capped, not zoom-scaled
// (`raster.ts`: BASE_RASTER 1100, and the detail overlay is capped at
// MAX_DETAIL 4096 over only the VISIBLE region), and the column is virtualized —
// so a 64× page costs a tall <div>, not a giant bitmap.
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
export const ZOOM_STEP = 1.2;

/** One US-Letter page's height at zoom 1 (a comfortable reading size). */
export const READING_BASE_HEIGHT = 960;
/** Vertical gap between pages at zoom 1 (scales with zoom). */
export const READING_PAGE_GAP = 24;

/**
 * Ceiling for the scroller's content height, with margin under Chromium's
 * per-element size limit (~33.55M px — LayoutUnit's 26.6 fixed-point range;
 * WebView2 is Chromium).
 *
 * This is a REAL DOM height, not a raster: the reading view sizes its spacer
 * `pageCount * rowH`. Past the limit the element silently clamps, so the tail of
 * the document becomes unreachable by scrolling AND `centerOn` can't land there
 * — while the page box keeps reporting the page it *meant*, so it reads e.g.
 * "800 / 1000" over page ~532, durably (review-caught: the widened MAX_ZOOM
 * made this reachable at ~533 pages, where the old ceiling needed ~5,683 and so
 * hid it).
 */
const SAFE_CONTENT_HEIGHT = 30_000_000;

/**
 * The largest zoom this document can take without its spacer exceeding
 * `SAFE_CONTENT_HEIGHT` — i.e. the point past which pages would stop being
 * reachable. Every page stays scrollable at any zoom the view allows.
 *
 * KNOWN BOUND, accepted: for a document of several thousand pages this ceiling
 * can fall BELOW a preset's honest target, so Actual Size / Fit Width then
 * render short of their label (e.g. Fit Width on a 5120px pane is honest to
 * ~4,400 pages; a 10,000-page doc gets ~44% of the pane). That is inherent to
 * laying the column out under ONE full-height DOM spacer — once row height must
 * be capped for reachability, no zoom-only fix exists. It fails SAFE (renders
 * smaller; never unreachable, never a wrong page number), and reachability beats
 * fidelity: a page you cannot scroll to is worse than one rendered small. The
 * escape, if it ever matters, is to drop the full-height spacer for a translated
 * window — a virtualization redesign, not a zoom change.
 */
export function maxZoomFor(pageCount: number): number {
  if (pageCount <= 0) return MAX_ZOOM;
  const rowHAtZoom1 = READING_BASE_HEIGHT + READING_PAGE_GAP;
  const fits = SAFE_CONTENT_HEIGHT / (pageCount * rowHAtZoom1);
  // Never below MIN_ZOOM: a document so long that even MIN_ZOOM overflows would
  // otherwise invert the clamp (max < min). It stays pinned at the floor, which
  // is honest — that is genuinely as far out as the view goes.
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fits));
}

/** Clamp to the view's range AND to what this document can render (see above). */
export const clampZoom = (z: number, pageCount: number): number =>
  Math.min(maxZoomFor(pageCount), Math.max(MIN_ZOOM, z));

/** A page's own geometry, as the reading view needs it for the zoom presets. */
export interface PageGeometry {
  /** Natural size at PDF scale 1 (72dpi points === CSS px). */
  width: number;
  height: number;
  /** Pending quarter-turns — swaps which natural edge is displayed. */
  rotation?: number;
}

/**
 * The page's natural DISPLAYED height in CSS px — what "100%" means for it.
 *
 * Rotation-aware: at 90/270 the page's natural WIDTH is what runs vertically.
 * Falls back to US Letter (792pt) for a page whose dimensions haven't resolved
 * yet (pdf.js reports 0×0 until its viewport arrives — the same case
 * `pageDisplayWidth` guards).
 */
export function naturalDisplayHeight(page: PageGeometry): number {
  const rotated = page.rotation === 90 || page.rotation === 270;
  const h = rotated ? page.width : page.height;
  return h > 0 ? h : 792;
}

/**
 * Zoom that renders the page at its true size — Acrobat's Actual Size (Ctrl+1).
 *
 * `zoom` here is relative to the reading view's own base page height, NOT to the
 * PDF's natural size, so 100% is not zoom 1: a US Letter page is 792pt tall
 * against a 960px base, i.e. zoom 0.825.
 */
export function actualSizeZoom(page: PageGeometry, readingBaseHeight: number): number {
  return naturalDisplayHeight(page) / readingBaseHeight;
}

/**
 * Zoom that fits the page's width to the available pane width — Acrobat's Fit
 * Width (Ctrl+2).
 *
 * `displayWidthAtBase` is the page's rotation-aware width at the BOARD's base
 * height (`canvas/layout.ts` `displayWidthOf`), because that is the ratio the
 * reading view already renders with: `width = displayWidthAtBase * pageHeight /
 * boardBaseHeight`. Solving that for the height whose width equals the pane and
 * converting to zoom gives the below. Returns 0 for degenerate input so callers
 * clamp rather than divide by zero.
 */
export function fitWidthZoom(
  availableWidth: number,
  displayWidthAtBase: number,
  boardBaseHeight: number,
  readingBaseHeight: number,
): number {
  if (availableWidth <= 0 || displayWidthAtBase <= 0 || readingBaseHeight <= 0) return 0;
  const pageHeight = (availableWidth * boardBaseHeight) / displayWidthAtBase;
  return pageHeight / readingBaseHeight;
}

/**
 * The page index window to render, padded by `overscan`.
 *
 * Extracted (not inline in DocumentView) so the clamp is testable: an unclamped
 * `first` could exceed `last` after a page-tier delete, and the row loop then
 * emitted NOTHING — a blank pane — which no test could catch while the maths
 * lived in the component. `last < first` here means "nothing to render".
 */
export function visibleRange(m: ReadingMetrics, overscan: number): { first: number; last: number } {
  const { rowH, viewportH, pageCount, contentHeight } = m;
  if (pageCount <= 0 || rowH <= 0) return { first: 0, last: -1 };
  const scrollTop = clampScrollTop(m.scrollTop, contentHeight, viewportH);
  return {
    first: Math.max(0, Math.floor(scrollTop / rowH) - overscan),
    last: Math.min(pageCount - 1, Math.ceil((scrollTop + viewportH) / rowH) + overscan),
  };
}

/**
 * The 1-based current page: the one occupying the most of the viewport, with
 * ties broken deliberately.
 *
 * - At the scroll extremes the answer is unambiguous and centring cannot move
 *   further, so clamp: scrolled to the top IS page 1; scrolled to the end IS the
 *   last page.
 * - Otherwise prefer the page nearest the viewport CENTRE — `DocumentView`'s
 *   `centerOn` lands its target's centre exactly on the viewport centre, so this
 *   is what makes jump-to-N report N (and stops the page box snapping back).
 *
 * Returns 1 for a degenerate/empty viewport.
 */
export function currentPageFor(m: ReadingMetrics): number {
  const { viewportH, rowH, pageHeight, pageCount, contentHeight } = m;
  if (pageCount <= 0 || viewportH <= 0 || rowH <= 0) return 1;

  const scrollTop = clampScrollTop(m.scrollTop, contentHeight, viewportH);
  const vFirst = Math.max(0, Math.min(pageCount - 1, Math.floor(scrollTop / rowH)));
  const vLast = Math.min(pageCount - 1, Math.floor((scrollTop + viewportH - 1) / rowH));
  if (vLast < vFirst) return Math.min(pageCount, vFirst + 1);

  // Top clamp first: when the whole document fits, both extremes are true at
  // once and "page 1" is the honest answer.
  if (scrollTop <= 0) return vFirst + 1;
  if (scrollTop + viewportH >= contentHeight - 1) return vLast + 1;

  const viewCentre = scrollTop + viewportH / 2;
  let best = vFirst;
  let bestOverlap = -1;
  let bestDist = Infinity;
  for (let i = vFirst; i <= vLast; i++) {
    const top = i * rowH;
    const overlap = Math.min(top + pageHeight, scrollTop + viewportH) - Math.max(top, scrollTop);
    const dist = Math.abs(top + pageHeight / 2 - viewCentre);
    const better =
      overlap > bestOverlap + TIE_EPS || (overlap > bestOverlap - TIE_EPS && dist < bestDist);
    if (better) {
      bestOverlap = Math.max(bestOverlap, overlap);
      bestDist = dist;
      best = i;
    }
  }
  return best + 1;
}
