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
  /** The placement's FULL device matrix [a,b,c,d,e,f] in page user space —
   * what C1's transform gesture manipulates (rect is just its bbox). */
  matrix: [number, number, number, number, number, number];
  /** Effective fill alpha at the draw (9.C3) — the opacity slider's seed. */
  opacity: number;
  /** C4: an inline (BI/ID/EI) draw vs a regular XObject placement —
   * replace/extract are XObject-only (the toolbar disables them). */
  kind: 'inline' | 'xobject';
  /** C3-tail: the tool-authored crop in the image's unit space, or null.
   * Only RECOGNIZED tool frames are reported (author clips stay null —
   * no handles, band-crop as before); the crop op replaces the whole
   * recognized stack, so this is also what the handles seed from. */
  crop: [number, number, number, number] | null;
}

/** The selected image's transform context (9.C1) — its user-space matrix plus
 * the page geometry the canvas gesture needs. One at a time (single selection);
 * PageCell renders the handles on the page whose id matches. */
export interface EditImageTransformCtx {
  pageId: string;
  index: number;
  matrix: [number, number, number, number, number, number];
  /** C3-tail: the listed tool crop (unit space) — seeds the edge handles. */
  crop: [number, number, number, number] | null;
  box: { x: number; y: number; width: number; height: number };
  bakedRotate: number;
  /** A transform commit is in flight — the overlay refuses to START a new
   * gesture (a rapid second nudge must not commit against the stale matrix). */
  busy: boolean;
}

interface EngineListing {
  images: {
    index: number;
    rect: [number, number, number, number];
    nested: boolean;
    matrix: [number, number, number, number, number, number];
    opacity: number;
    kind: 'inline' | 'xobject';
    crop?: [number, number, number, number] | null;
    /** 9-§I.0-S8: the placement is wholly outside the active clip (invisible).
     * Filtered out below so clipped-away images are never offered as editable.
     * Each surviving item keeps its ENGINE index, so filtering never desyncs a
     * mutator target. */
    clipped?: boolean;
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
  // 9-§I.0-S8: drop clipped-away (invisible) placements — never offered as
  // editable. Surviving items keep their engine `index`, so a mutator target
  // is never desynced by the filter.
  const visible = (listing.images ?? []).filter((image) => !image.clipped);
  return visible.map((image) => ({
    index: image.index,
    nested: Boolean(image.nested),
    rect: pdfRectToDisplay(image.rect, geometry.box, geometry.bakedRotate),
    matrix: image.matrix,
    opacity: typeof image.opacity === 'number' ? image.opacity : 1,
    kind: image.kind === 'inline' ? 'inline' : 'xobject',
    // Degenerate guard: a pre-tail file with DISJOINT stacked crops lists
    // an inverted intersection (x0>x1) — no sane handle seed exists, so
    // treat it as no tool crop (band-crop heals it; the band commit
    // collapse-replaces the whole stack).
    crop:
      Array.isArray(image.crop) &&
      image.crop.length === 4 &&
      image.crop.every((v) => Number.isFinite(v)) &&
      image.crop[0] < image.crop[2] &&
      image.crop[1] < image.crop[3]
        ? [image.crop[0], image.crop[1], image.crop[2], image.crop[3]]
        : null,
  }));
}
