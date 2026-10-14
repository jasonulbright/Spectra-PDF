// Where the canvas draws the appearance of an imported annotation that the
// commit keeps as written.
//
// The commit writes the original with /Rect moved by the distance the user
// moved the annotation (`imported-carry.ts` `patchedOriginal`), and a viewer
// maps the appearance box onto /Rect (ISO 32000-2 12.5.5). The preview is
// therefore the bitmap of the original's rectangle, drawn on that rectangle
// moved by the same distance.
import { pdfRectToDisplay } from './pdfx-build';
import { rotateNormalizedRect } from './redaction';
import { quarterTurn } from './appearance-raster';
import type { AppearanceRaster, QuarterTurn } from './appearance-raster';

export interface AppearancePlacement {
  /** The box the bitmap fills, in the view frame, display-normalized. */
  box: { x: number; y: number; w: number; h: number };
  /** How far the bitmap turns, clockwise, inside that box. */
  turn: QuarterTurn;
}

/**
 * The original's rectangle as the page shows it after the move.
 *
 * `raster` gives the rectangle in default user space, the page's view box and
 * its /Rotate. `moved` is the move since the import, with the factors a
 * change of size scales the rectangle by, display-normalized in the stored
 * frame: the frame of the file's /Rotate turned by
 * `pendingRotation`. The view frame is the stored frame turned by
 * `viewRotation`.
 */
export function originalAppearancePlacement(
  raster: Pick<AppearanceRaster, 'rect' | 'view' | 'pageRotate'>,
  moved: { dx: number; dy: number; sx?: number; sy?: number },
  pendingRotation: number,
  viewRotation: number,
): AppearancePlacement {
  const [x0, y0, x1, y1] = raster.view;
  const imported = pdfRectToDisplay(raster.rect, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, raster.pageRotate);
  const stored = rotateNormalizedRect(imported, pendingRotation);
  const placed = { x: stored.x + moved.dx, y: stored.y + moved.dy, w: stored.w * (moved.sx ?? 1), h: stored.h * (moved.sy ?? 1) };
  return { box: rotateNormalizedRect(placed, viewRotation), turn: quarterTurn(raster.pageRotate, pendingRotation, viewRotation) };
}
