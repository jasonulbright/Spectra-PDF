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

export type DropTarget =
  | { kind: 'into'; docId: string; index: number }
  | { kind: 'between'; docIndex: number };

// Below this on-screen row height, into-strip targets are too small to hit
// reliably, so drops fall back to between-row slots. usePageDrag also raises
// its drag-start threshold below the same gate.
export const INTO_MIN_SCREEN_PX = 90;

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

export function computeDropTarget(
  layout: CanvasLayout,
  worldX: number,
  worldY: number,
  scale: number,
  excludeIds: ReadonlySet<string> | null,
  allowInto: boolean,
): DropTarget {
  const items = layout.items;
  if (allowInto && DOC_HEIGHT * scale >= INTO_MIN_SCREEN_PX) {
    for (const item of items) {
      if (worldY >= item.y && worldY <= item.y + item.height) {
        return {
          kind: 'into',
          docId: item.doc.id,
          index: insertionIndexInCard(item, worldX, worldY, excludeIds),
        };
      }
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
