// Edit-mode VECTOR objects (Phase 9.D1): fetch the engine's per-page vector
// listing and project the PDF user-space bboxes into the display-normalized
// space PageCell overlays draw in — the same {box, bakedRotate} idiom every
// other edit overlay uses (mirrors edit-images' fetchEditPlacements). A
// vector object is a drawn path (fill/stroke/fillstroke); D1 lists, selects,
// and deletes them. Pending in-memory page rotation is applied at RENDER time
// by PageCell (rotateNormalizedRect), like image placements and redaction.
import { pdfRectToDisplay } from './pdfx-build';
import type { PageGeometry } from './redaction';

export interface EditVectorObject {
  /** The engine's object id — depth-first painted-path order on the page. */
  index: number;
  /** Display-normalized bbox at the page's BAKED orientation. */
  rect: { x: number; y: number; w: number; h: number };
  /** How the path is painted — drives the selection affordance's honesty. */
  kind: 'fill' | 'stroke' | 'fillstroke';
  /** Best-effort fill colour [r,g,b] 0-1 (device spaces only), else null. */
  fill: [number, number, number] | null;
  /** Best-effort stroke colour [r,g,b] 0-1 (device spaces only), else null. */
  stroke: [number, number, number] | null;
}

interface EngineListing {
  vectors: {
    index: number;
    rect: [number, number, number, number];
    kind: 'fill' | 'stroke' | 'fillstroke';
    fill?: [number, number, number] | null;
    stroke?: [number, number, number] | null;
  }[];
}

function clampRgb(c: unknown): [number, number, number] | null {
  return Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? [c[0] as number, c[1] as number, c[2] as number]
    : null;
}

export async function fetchEditVectors(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  workingPath: string,
  pageNumber: number,
  geometry: PageGeometry,
): Promise<EditVectorObject[]> {
  const listing = (await call('list_page_vectors', {
    file: workingPath,
    page: pageNumber,
  })) as unknown as EngineListing;
  return (listing.vectors ?? []).map((v) => ({
    index: v.index,
    rect: pdfRectToDisplay(v.rect, geometry.box, geometry.bakedRotate),
    kind: v.kind === 'stroke' ? 'stroke' : v.kind === 'fillstroke' ? 'fillstroke' : 'fill',
    fill: clampRgb(v.fill),
    stroke: clampRgb(v.stroke),
  }));
}
