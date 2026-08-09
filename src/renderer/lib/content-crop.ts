/**
 * Content-aware crop — the panel's own model.
 *
 * The measurement is the engine's; what lives here is the two pieces of
 * arithmetic the panel does around it, kept out of the component because
 * there is no DOM test environment: reading the page-scope field, and turning
 * a preview into the counts the reader is shown before committing.
 */

import { parsePageRangeField, type PageRangeResult } from './page-range';

export interface ContentCropTrim {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export interface ContentCropPage {
  page: number;
  /** `ink` for a scanned page, `content` for a born-digital one. */
  source: string;
  box: number[];
  trimmed: ContentCropTrim;
}

export interface ContentCropResult {
  box: string;
  margin: number;
  changed: number;
  pages: ContentCropPage[];
  skipped: { page: number; reason: string }[];
  preview: boolean;
}

/** Below this many points a trim is not worth calling a crop — it is the
 * rounding of a page that was already tight to its content. */
const TRIM_EPSILON = 0.5;

export interface ContentCropSummary {
  /** Pages whose box actually moves. */
  cropped: number;
  /** Pages measured but already tight — reported, never hidden: "nothing
   * happened" is a result, and a silent one reads as a failure. */
  unchanged: number;
  /** Pages that yielded no box at all (blank, or degenerate). */
  skipped: number;
  /** How many of the cropped pages were measured from INK. */
  scanned: number;
  /** The largest single-edge trim, in points — the honest headline for
   * "how much margin is coming off". */
  largestTrim: number;
}

export function summarizeContentCrop(result: ContentCropResult): ContentCropSummary {
  let cropped = 0;
  let unchanged = 0;
  let scanned = 0;
  let largestTrim = 0;
  for (const page of result.pages ?? []) {
    const t = page.trimmed;
    const biggest = Math.max(t.left, t.right, t.top, t.bottom);
    if (biggest < TRIM_EPSILON) {
      unchanged++;
      continue;
    }
    cropped++;
    if (page.source === 'ink') scanned++;
    largestTrim = Math.max(largestTrim, biggest);
  }
  return {
    cropped,
    unchanged,
    skipped: result.skipped?.length ?? 0,
    scanned,
    largestTrim: Math.round(largestTrim * 100) / 100,
  };
}

export type PageScope = PageRangeResult;

/** The page-scope field, read the one way — see `lib/page-range.ts` for the
 * syntax every such field shares. */
export const parsePageScope = parsePageRangeField;
