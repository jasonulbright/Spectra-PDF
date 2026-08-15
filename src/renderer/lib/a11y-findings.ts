// Accessibility findings drawn on the page — the review model, pure over data.
//
// A finding is transient VIEW state with the table-region lifetime: bound to a
// page id, invalidated when its file's bytes change, and carrying nothing into
// any output. Nothing here ever touches the PDF — a finding says where the
// checker looked, and the fix that answers it is a separate, ordinary op.
//
// Only `content` addresses reach this module. A `struct` address is a tree
// path with no geometry of its own, and an `object` address names a thing an
// owning panel already lists; both jump elsewhere (see `lib/a11y-jump.ts`).
import type { NormalizedRect, Quarter } from './table-review';

export interface A11yFinding {
  id: string;
  /** File path when the report ran — used only to invalidate on a byte change. */
  path: string;
  pageId: string;
  /** 1-based position in the file when the report ran, for the panel's grouping. */
  page: number;
  /** Which check produced it, so a published set can be labelled by its check. */
  checkId: string;
  /** The engine's structured reason, never a rendered sentence. */
  detailKey: string;
  /** Display-normalized (0..1 of the page cell) in the orientation the page was
   * shown at when the report ran. */
  rect: NormalizedRect;
  /** The PageRef's in-memory rotation DELTA when the report ran. */
  rotationAtDraw: Quarter;
  /** Short text of what was found, for recognizing a false positive at a glance. */
  preview: string;
}

/** A finding bound to a retired page id would draw a box on a page the
 * document no longer has. Same prune, same reason, as the table regions. */
export function prunedFindings(
  findings: readonly A11yFinding[],
  livePageIds: ReadonlySet<string>,
): A11yFinding[] {
  return findings.filter((f) => livePageIds.has(f.pageId));
}

export function findingsByPage(
  findings: readonly A11yFinding[],
): Map<string, A11yFinding[]> {
  const map = new Map<string, A11yFinding[]>();
  for (const f of findings) {
    const arr = map.get(f.pageId);
    if (arr) arr.push(f);
    else map.set(f.pageId, [f]);
  }
  return map;
}

/** What the canvas needs to place one finding: the file's own page number and
 * the rectangle in un-rotated user space. The engine reports both. */
export interface PlaceableFinding {
  page: number;
  rect: [number, number, number, number];
  checkId: string;
  detailKey: string;
  preview: string;
}

/** The handlers the page cell needs to draw and select a finding. */
export interface A11yFindingHandlers {
  selectedId: string | null;
  onSelect: (id: string) => void;
}
