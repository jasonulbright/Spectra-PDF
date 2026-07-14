// Linear-list reorder math for the nav-pane Pages panel (Phase 4 M3.1b). The
// panel shows one file's pages flattened across its documents; a drag drops at
// a flat insertion index. This maps that to the (toDocId, toIndex) a
// MOVE_PAGE/MOVE_PAGES dispatch expects — toIndex counted against the target
// doc's pages AFTER the moving pages are removed (the reducer's frame), so a
// cross-manifest-partition drag lands correctly. Pure + unit-tested; the panel
// only wires pointer events to it. (usePageDrag's world-coordinate math stays
// canvas-only — § 14.4.)

export interface ReorderItem {
  docId: string;
  pageId: string;
}

export interface ReorderTarget {
  toDocId: string;
  toIndex: number;
}

/**
 * @param items      the file's pages in flat workspace order
 * @param movingIds  the page ids being moved (a subset of items)
 * @param flatIndex  insertion index in [0, items.length] (rows above the drop)
 * @returns the move target, or null when there's nothing to anchor to (every
 *          page is moving — the reducer would reject it as a no-op anyway).
 */
export function computeReorderTarget(
  items: ReorderItem[],
  movingIds: string[],
  flatIndex: number,
): ReorderTarget | null {
  const movingSet = new Set(movingIds);
  // Rest gap: how many NON-moving pages sit above the insertion point.
  let g = 0;
  const upto = Math.max(0, Math.min(flatIndex, items.length));
  for (let i = 0; i < upto; i++) {
    if (!movingSet.has(items[i].pageId)) g += 1;
  }
  // Non-moving pages, each tagged with its local (per-doc) rest index — the
  // post-removal frame MOVE_PAGES inserts against.
  const restFlat: ReorderTarget[] = [];
  const local = new Map<string, number>();
  for (const it of items) {
    if (movingSet.has(it.pageId)) continue;
    const l = local.get(it.docId) ?? 0;
    restFlat.push({ toDocId: it.docId, toIndex: l });
    local.set(it.docId, l + 1);
  }
  if (g < restFlat.length) return restFlat[g]; // insert before the g-th rest page
  if (restFlat.length > 0) {
    const last = restFlat[restFlat.length - 1]; // append after the last rest page
    return { toDocId: last.toDocId, toIndex: last.toIndex + 1 };
  }
  return null; // every page moving — no anchor
}
