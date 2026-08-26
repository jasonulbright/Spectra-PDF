import type { DocPlacement, CanvasLayout } from './layout';
import {
  BASE_PAGE_HEIGHT,
  DOC_HEIGHT,
  DOC_GAP_Y,
  ROWS_TOP,
  ROW_GAP,
  CARD_PAD_X,
  PAGE_GAP,
  displayWidthOf,
  wrapPages,
} from './layout';
import type { PageLike } from './layout';
import { dropTargetGate } from '../lib/drop-gate';

export type DropTarget =
  | { kind: 'into'; docId: string; index: number }
  | { kind: 'between'; docIndex: number }
  // Over a document, but the strip is drawn too small at this zoom for an
  // insertion point to be aimed at. A refusal, not a fallback: silently
  // turning the gesture into a between-row drop moved pages into a NEW
  // document the user never asked for, and the smaller the target the more
  // often it happened.
  | { kind: 'refused'; reason: 'zoom'; screenPx: number; minPx: number };

function insertionIndexInRow(row: PageLike[], relX: number): number {
  let x = 0;
  let index = 0;
  for (const page of row) {
    const w = displayWidthOf(page);
    if (relX <= x + w / 2) return index;
    index++;
    x += w + PAGE_GAP;
  }
  return index;
}

// Insertion index across a card's wrapped rows: pick the row under the world
// Y, then walk that row's midpoints. Indices count visible (non-excluded)
// pages, matching how the reducer inserts after removal.
function insertionIndexInCard(
  item: DocPlacement,
  wx: number,
  wy: number,
  excludeIds: ReadonlySet<string> | null,
): number {
  const rows = wrapPages(item.doc.pages, excludeIds);
  const rowIndex = Math.max(
    0,
    Math.min(
      rows.length - 1,
      Math.floor((wy - item.y - ROWS_TOP) / (BASE_PAGE_HEIGHT + ROW_GAP)),
    ),
  );
  let index = 0;
  for (let r = 0; r < rowIndex; r++) index += rows[r].length;
  return index + insertionIndexInRow(rows[rowIndex], wx - item.x - CARD_PAD_X);
}

/** Whether a world Y falls in a gap bounded by a card above AND below it. */
function inInteriorGap(items: readonly DocPlacement[], worldY: number): boolean {
  for (let i = 0; i < items.length - 1; i++) {
    if (worldY > items[i].y + items[i].height && worldY < items[i + 1].y) return true;
  }
  return false;
}

export function computeDropTarget(
  layout: CanvasLayout,
  worldX: number,
  worldY: number,
  scale: number,
  excludeIds: ReadonlySet<string> | null,
  allowInto: boolean,
): DropTarget {
  const items = layout.items;
  if (allowInto) {
    const gate = dropTargetGate(DOC_HEIGHT * scale);
    for (const item of items) {
      if (worldY >= item.y && worldY <= item.y + item.height) {
        if (!gate.ok) {
          return { kind: 'refused', reason: 'zoom', screenPx: gate.screenPx, minPx: gate.minPx };
        }
        return {
          kind: 'into',
          docId: item.doc.id,
          index: insertionIndexInCard(item, worldX, worldY, excludeIds),
        };
      }
    }
    // The gap BETWEEN two cards is gated by the same predicate, for the same
    // reason. It scales with the board, so at the zoom where a card is too
    // small to aim at, the gap is a handful of pixels — and hitting it splits
    // pages into a new document, which is precisely the outcome the refusal
    // above exists to prevent. Refusing only the card band would leave that
    // outcome reachable through a sliver, which is worse than reaching it
    // through the card.
    //
    // The open space before the first card and after the last is NOT gated:
    // it is unbounded at every zoom, so it stays aimable and a zoomed-out drag
    // always keeps a usable target.
    if (!gate.ok && inInteriorGap(items, worldY)) {
      return { kind: 'refused', reason: 'zoom', screenPx: gate.screenPx, minPx: gate.minPx };
    }
  }
  let docIndex = 0;
  for (const item of items) {
    if (item.y + item.height / 2 < worldY) docIndex++;
  }
  return { kind: 'between', docIndex };
}

export function betweenSlotY(layout: CanvasLayout, docIndex: number): number {
  const items = layout.items;
  if (items.length === 0) return 0;
  if (docIndex >= items.length) {
    const last = items[items.length - 1];
    return last.y + last.height + DOC_GAP_Y;
  }
  return items[docIndex].y;
}
