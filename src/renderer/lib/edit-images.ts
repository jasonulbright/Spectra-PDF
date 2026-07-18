// Edit-mode image placements (Phase 7.1): fetch the engine's per-page
// listing and project the PDF user-space rects into the display-normalized
// space PageCell overlays draw in — the same {box: page.view, bakedRotate:
// page.rotate} geometry every other overlay uses (one conversion idiom
// everywhere). Pending in-memory page rotation is applied at RENDER time by
// PageCell (rotateNormalizedRect), exactly like redaction marks.
import { pdfRectToDisplay } from './pdfx-build';
import type { PageGeometry } from './redaction';

export interface EditImagePlacement {
  /** The engine's placement id — depth-first image-draw order on the page. */
  index: number;
  /** Display-normalized bbox at the page's BAKED orientation. */
  rect: { x: number; y: number; w: number; h: number };
  /** Drawn inside a Form XObject (edits copy the form for that draw). */
  nested: boolean;
}

interface EngineListing {
  images: {
    index: number;
    rect: [number, number, number, number];
    nested: boolean;
  }[];
}

export async function fetchEditPlacements(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  workingPath: string,
  pageNumber: number,
  geometry: PageGeometry,
): Promise<EditImagePlacement[]> {
  const listing = (await call('list_page_images', {
    file: workingPath,
    page: pageNumber,
  })) as unknown as EngineListing;
  return (listing.images ?? []).map((image) => ({
    index: image.index,
    nested: Boolean(image.nested),
    rect: pdfRectToDisplay(image.rect, geometry.box, geometry.bakedRotate),
  }));
}
