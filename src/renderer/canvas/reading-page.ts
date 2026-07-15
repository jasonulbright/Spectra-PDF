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
  return (
    anchor.rowH === m.rowH &&
    anchor.viewportH === m.viewportH &&
    Math.abs(m.scrollTop - anchor.scrollTop) <= ANCHOR_EPS
  );
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

  // `scrollTop` is React state fed by the scroll EVENT, but a page-tier edit
  // shrinks pageCount/contentHeight SYNCHRONOUSLY — so for one render it can
  // point past the end of the now-shorter content, before the browser clamps the
  // DOM and fires the corrective scroll event. Clamp to the reachable range so
  // the readout names the page that will actually be on screen (review-caught:
  // deleting the last page while scrolled to it reported a page number over what
  // was, that frame, a blank viewport).
  const maxScroll = Math.max(0, contentHeight - viewportH);
  const scrollTop = Math.min(Math.max(0, m.scrollTop), maxScroll);

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
