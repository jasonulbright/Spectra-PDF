// Types + pure helpers for the visual (pixel) compare view. The diff itself
// runs engine-side (Ghostscript raster + Python pixel diff — see
// docs/architecture/09-phase2g-compare.md); this module only holds the result
// shape and the overlay math the panel uses to project the engine's
// changed-region rectangles onto pdf.js-rendered page canvases.

export interface VisualRegion {
  x: number; // PDF points, from the left of the rendered page
  y: number; // PDF points, from the TOP of the rendered page
  w: number;
  h: number;
}

export interface VisualPagePair {
  page: number;
  identical?: boolean;
  diff_pixels?: number;
  total_pixels?: number;
  diff_ratio?: number;
  regions?: VisualRegion[];
  width_pts?: number;
  height_pts?: number;
  only_in?: 'a' | 'b';
}

export interface VisualCompareSummary {
  identical: boolean;
  pages_a: number;
  pages_b: number;
  pairs_compared: number;
  pairs_differing: number;
  unpaired_a: number;
  unpaired_b: number;
  dpi: number;
}

export interface VisualCompareResult {
  summary: VisualCompareSummary;
  pages: VisualPagePair[];
}

export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Project an engine region (PDF points, y from the top of the rendered page
 * — the same orientation pdf.js renders) onto a displayed canvas of
 * `displayWidth` CSS px. A pure scale: the engine's compare space and the
 * pdf.js render share origin and axes, and a point is a point in both.
 * `pageWidthPts` is the width in points THAT THE CANVAS REPRESENTS — the
 * displayed page's own width (pdf.js viewport width at scale 1), NOT the
 * pair's padded compare-space `width_pts`. When the pair's other page is
 * wider, regions in the padded band project past this canvas's right edge by
 * design; the viewer's overflow-hidden container clips them. */
export function scaleRegionToDisplay(
  region: VisualRegion,
  pageWidthPts: number,
  displayWidth: number,
): DisplayRect {
  const s = pageWidthPts > 0 ? displayWidth / pageWidthPts : 0;
  return {
    left: region.x * s,
    top: region.y * s,
    width: region.w * s,
    height: region.h * s,
  };
}

/** The page pairs worth listing in the visual result: differing pairs and
 * unpaired extras (identical pairs are summarized, not listed). */
export function listableVisualPages(pages: VisualPagePair[]): VisualPagePair[] {
  return pages.filter((p) => p.only_in != null || p.identical === false);
}
