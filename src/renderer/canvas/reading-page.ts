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
  const { scrollTop, viewportH, rowH, pageHeight, pageCount, contentHeight } = m;
  if (pageCount <= 0 || viewportH <= 0 || rowH <= 0) return 1;

  const vFirst = Math.max(0, Math.floor(scrollTop / rowH));
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
