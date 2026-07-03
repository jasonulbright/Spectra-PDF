import type { OpenDocument } from '../state/types';

export const BASE_PAGE_HEIGHT = 280;
export const PAGE_GAP = 18;
export const ROW_GAP = PAGE_GAP; // vertical gap between wrapped rows (flex `gap`)
export const CARD_PAD_X = 16 + 6;
const CARD_PAD_TOP = 10;
const HEADER_BLOCK = 32;
const CARD_PAD_BOTTOM = 14;
export const DOC_GAP_Y = 30;

const MIN_PAGES = 5;
const REF_PAGE_WIDTH = Math.round((BASE_PAGE_HEIGHT * 612) / 792);
export const MIN_DOC_WIDTH =
  MIN_PAGES * REF_PAGE_WIDTH + (MIN_PAGES - 1) * PAGE_GAP + CARD_PAD_X * 2;

export const ADD_PAGE_WIDTH = REF_PAGE_WIDTH;

// Deviation from the PDFx original (single-row strips): page strips wrap into
// rows at this content width. PDFx's canvas hosts short assembled strips;
// Spectra's primary case is one long document, where a single row forces the
// fit scale toward zero and makes every page illegible. Wrapping caps card
// width, so fit-to-width stays legible and the canvas scrolls vertically like
// a document. Must match the flex-wrap rendering in DocumentRow — both wrap
// greedily over the same integer page widths and gap.
export const MAX_ROW_WIDTH = 1600;

export interface DocPlacement {
  doc: OpenDocument;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasLayout {
  items: DocPlacement[];
  contentWidth: number;
  contentHeight: number;
  slotHeight: number;
}

export function pageDisplayWidth(width: number, height: number): number {
  // Pages indexed before their dimensions resolve report 0×0 — show them at
  // the reference (US Letter) aspect until the real viewport arrives.
  if (width <= 0 || height <= 0) return REF_PAGE_WIDTH;
  return Math.max(6, Math.round((BASE_PAGE_HEIGHT * width) / height));
}

export interface PageLike {
  id: string;
  width: number;
  height: number;
  rotation?: number; // in-memory quarter-turns pending commit — swaps the display aspect
}

export function displayWidthOf(page: PageLike): number {
  return page.rotation === 90 || page.rotation === 270
    ? pageDisplayWidth(page.height, page.width)
    : pageDisplayWidth(page.width, page.height);
}

// Greedy row wrap, identical to what flexbox produces for the same explicit
// pixel widths and gap. `excludeId` drops the collapsed (dragged) page, which
// leaves the flex flow via position:absolute and so doesn't affect wrapping.
export function wrapPages<T extends PageLike>(pages: T[], excludeId: string | null): T[][] {
  const rows: T[][] = [];
  let row: T[] = [];
  let x = 0;
  for (const page of pages) {
    if (page.id === excludeId) continue;
    const w = displayWidthOf(page);
    const extended = row.length === 0 ? w : x + PAGE_GAP + w;
    if (row.length > 0 && extended > MAX_ROW_WIDTH) {
      rows.push(row);
      row = [page];
      x = w;
    } else {
      row.push(page);
      x = extended;
    }
  }
  if (row.length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

export function rowWidth(row: PageLike[]): number {
  return (
    row.reduce((sum, p) => sum + displayWidthOf(p), 0) +
    Math.max(0, row.length - 1) * PAGE_GAP
  );
}

function docSize(doc: OpenDocument): { width: number; height: number } {
  const rows = wrapPages(doc.pages, null);
  const contentWidth = Math.max(...rows.map(rowWidth), 0);
  return {
    width: Math.max(MIN_DOC_WIDTH, contentWidth + CARD_PAD_X * 2),
    height:
      CARD_PAD_TOP +
      HEADER_BLOCK +
      rows.length * BASE_PAGE_HEIGHT +
      (rows.length - 1) * ROW_GAP +
      CARD_PAD_BOTTOM,
  };
}

// Height of a single-row document card — the ghost/add rows and the shift
// animation use this fixed slot; real placements carry their own height.
export const DOC_HEIGHT = CARD_PAD_TOP + HEADER_BLOCK + BASE_PAGE_HEIGHT + CARD_PAD_BOTTOM;
export const DOC_SLOT = DOC_HEIGHT + DOC_GAP_Y;

// Content-box offset of the first page row within a card, used by the
// drop-target math to map a world Y onto a wrapped row.
export const ROWS_TOP = CARD_PAD_TOP + HEADER_BLOCK;

export function computeLayout(docs: OpenDocument[]): CanvasLayout {
  const sizes = docs.map(docSize);
  const contentWidth = Math.max(1, ...sizes.map((s) => s.width));

  let y = 0;
  const items: DocPlacement[] = docs.map((doc, i) => {
    const placement: DocPlacement = {
      doc,
      x: 0,
      y,
      width: sizes[i].width,
      height: sizes[i].height,
    };
    y += sizes[i].height + DOC_GAP_Y;
    return placement;
  });

  let contentHeight = Math.max(1, y - DOC_GAP_Y);
  if (docs.length > 0) contentHeight += DOC_GAP_Y + DOC_HEIGHT; // Add-document row
  return {
    items,
    contentWidth,
    contentHeight,
    slotHeight: items.length > 0 ? items[0].height + DOC_GAP_Y : DOC_SLOT,
  };
}

export { computeDropTarget, betweenSlotY } from './drop-target';
export type { DropTarget } from './drop-target';
