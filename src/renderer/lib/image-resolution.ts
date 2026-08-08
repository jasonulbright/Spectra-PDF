// The image-resolution summary's model, shared by Properties ▸ Advanced and
// the Compress panel so the two surfaces cannot report a document differently.
// Pure — which message a summary selects, and whether a document counts as
// scanned, are rules that deserve tests rather than components.

export interface ImageResolutionSummary {
  /** Pages in the document. */
  pages: number;
  /** Raster placements whose effective resolution was measured. */
  images: number;
  /** Raster placements whose pixel dimensions or placed size are degenerate. */
  unmeasured: number;
  /** Null when nothing measurable was found. */
  minDpi: number | null;
  medianDpi: number | null;
  maxDpi: number | null;
  /** Pages the MRC classifier accepts as scans. */
  scanPages: number;
}

export const EMPTY_IMAGE_RESOLUTION: ImageResolutionSummary = {
  pages: 0,
  images: 0,
  unmeasured: 0,
  minDpi: null,
  medianDpi: null,
  maxDpi: null,
  scanPages: 0,
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function dpi(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function parseImageResolution(raw: Record<string, unknown>): ImageResolutionSummary {
  const images = count(raw.images);
  return {
    pages: count(raw.pages),
    images,
    unmeasured: count(raw.unmeasured),
    // A count of zero has no resolutions to report, whatever the payload says.
    minDpi: images > 0 ? dpi(raw.min_dpi) : null,
    medianDpi: images > 0 ? dpi(raw.median_dpi) : null,
    maxDpi: images > 0 ? dpi(raw.max_dpi) : null,
    scanPages: count(raw.scan_pages),
  };
}

/** Which message the summary reads as: nothing to report, one resolution the
 * whole document shares, or a spread. */
export type ResolutionShape = 'none' | 'single' | 'range';

export function resolutionShape(summary: ImageResolutionSummary): ResolutionShape {
  if (summary.images === 0 || summary.minDpi === null || summary.maxDpi === null) return 'none';
  return summary.minDpi === summary.maxDpi ? 'single' : 'range';
}

/** Whether the document reads as a scan. A majority of pages, not all of
 * them: a 272-page scan with a typed cover page is still a scanned document,
 * and requiring every page would answer "no" for the corpus the question
 * exists to serve. */
export function isScanClassified(summary: ImageResolutionSummary): boolean {
  return summary.scanPages > 0 && summary.scanPages * 2 > summary.pages;
}
