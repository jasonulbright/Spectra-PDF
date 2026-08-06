// The printer-marks model: what a mark set is made of, and what the page pays
// for it.
//
// The page GROWS to hold marks — a PDF page carries no room outside its trim,
// so the panel has to be able to state the growth before the user commits to
// it. That arithmetic and the mark vocabulary live here rather than in the
// panel, because there is no DOM test environment and a guard in a component
// is a guard with no test.

export const MARK_KINDS = ['crop', 'registration', 'colorbars', 'pageinfo'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export const MARK_STYLES = ['western', 'japanese'] as const;
export type MarkStyle = (typeof MARK_STYLES)[number];

/** The stroke weights a press expects, in points. */
export const MARK_WEIGHTS = [0.125, 0.25, 0.5] as const;

/** PDF's own page-extent ceiling (points). */
export const MAX_PAGE_EXTENT = 14400;

export interface PrinterMarkPage {
  page: number;
  marked: boolean;
  trim_source: string;
  trim: number[];
  media: number[];
  crop: number[];
  bleed: number[];
  art: number[];
}

export interface PrinterMarkReport {
  pages: PrinterMarkPage[];
  marked: number;
  without_trim_box: number;
}

/** Points each edge gains. Marks start `offset` outside the trim and run
 *  `length` further, so that sum is exactly what the media box grows by. */
export function markGrowth(offset: number, length: number): number {
  return Math.round((Math.max(0, offset) + Math.max(0, length)) * 1000) / 1000;
}

/** The page size after marks, or null when either input is unusable. */
export function grownExtent(
  media: number[],
  offset: number,
  length: number,
): { width: number; height: number } | null {
  if (media.length < 4) return null;
  const growth = markGrowth(offset, length) * 2;
  const width = Math.abs(media[2] - media[0]) + growth;
  const height = Math.abs(media[3] - media[1]) + growth;
  return { width, height };
}

/** Would this growth push a page past PDF's own limit? The engine refuses it;
 *  the panel says so first rather than letting the refusal be the news. */
export function exceedsPageLimit(
  media: number[],
  offset: number,
  length: number,
): boolean {
  const grown = grownExtent(media, offset, length);
  if (!grown) return false;
  return grown.width > MAX_PAGE_EXTENT || grown.height > MAX_PAGE_EXTENT;
}

/** The catalog key naming which box the trim was taken from. A document with
 *  no trim box is being guessed at, and the panel has to say which guess. */
export function trimSourceKey(source: string): string {
  switch (source) {
    case 'trim':
      return 'panel.printerMarks.sourceTrim';
    case 'crop':
      return 'panel.printerMarks.sourceCrop';
    case 'media':
      return 'panel.printerMarks.sourceMedia';
    default:
      return 'panel.printerMarks.sourceDefault';
  }
}
