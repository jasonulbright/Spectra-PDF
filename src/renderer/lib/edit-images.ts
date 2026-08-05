// Edit-mode image placements: fetch the engine's per-page
// listing and project the PDF user-space rects into the display-normalized
// space PageCell overlays draw in — the same {box: page.view, bakedRotate:
// page.rotate} geometry every other overlay uses (one conversion idiom
// everywhere). Pending in-memory page rotation is applied at RENDER time by
// PageCell (rotateNormalizedRect), exactly like redaction marks.
import { pdfRectToDisplay } from './pdfx-build';
import type { PageGeometry } from './redaction';

/** The mask WIRE shape `set_image_opacity` takes: the full
 * gradient params, or {kind:"none"} to clear a carried mask. */
export type EditImageMaskParam =
  | { kind: 'none' }
  | {
      kind: 'linear' | 'radial';
      from: [number, number];
      to: [number, number];
      start_alpha: number;
      end_alpha: number;
    };

export interface EditImagePlacement {
  /** The engine's placement id — depth-first image-draw order on the page. */
  index: number;
  /** Display-normalized bbox at the page's BAKED orientation. */
  rect: { x: number; y: number; w: number; h: number };
  /** Drawn inside a Form XObject (edits copy the form for that draw). */
  nested: boolean;
  /** The placement's FULL device matrix [a,b,c,d,e,f] in page user space —
   * what the transform gesture manipulates (rect is just its bbox). */
  matrix: [number, number, number, number, number, number];
  /** Effective fill alpha at the draw — the opacity slider's seed. */
  opacity: number;
  /** Effective blend mode at the draw — the blend select's seed. */
  blend: string;
  /** The tool gradient mask in scope, unit space — seeds the
   * mask controls + the on-canvas from/to dots. Author soft masks are
   * never reported (there is no tool mask to re-edit). */
  mask: {
    kind: 'linear' | 'radial';
    from: [number, number];
    to: [number, number];
    startAlpha: number;
    endAlpha: number;
  } | null;
  /** An inline (BI/ID/EI) draw vs a regular XObject placement.
   * 'vector' is a placed SVG graphic; the whole transform
   * family applies, replace/extract refuse (toolbar disables). */
  kind: 'inline' | 'xobject' | 'vector';
  /** The tool-authored crop in the image's unit space, or null.
   * Only RECOGNIZED tool frames are reported (author clips stay null —
   * no handles, band-crop as before); the crop op replaces the whole
   * recognized stack, so this is also what the handles seed from. */
  crop: [number, number, number, number] | null;
}

/** The selected image's transform context — its user-space matrix plus
 * the page geometry the canvas gesture needs. One at a time (single selection);
 * PageCell renders the handles on the page whose id matches. */
export interface EditImageTransformCtx {
  pageId: string;
  index: number;
  matrix: [number, number, number, number, number, number];
  /** The listed tool crop (unit space) — seeds the edge handles. */
  crop: [number, number, number, number] | null;
  /** The listed tool gradient mask — the overlay renders its
   * from/to dots for direct manipulation (null = no dots). The vector
   * reuse path passes null (vectors don't mask). */
  mask: EditImagePlacement['mask'];
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
    blend?: string;
    mask?: {
      kind: string;
      from: [number, number];
      to: [number, number];
      start_alpha: number;
      end_alpha: number;
    } | null;
    kind: 'inline' | 'xobject' | 'vector';
    crop?: [number, number, number, number] | null;
    /** The placement is wholly outside the active clip (invisible).
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
  // Drop clipped-away (invisible) placements — never offered as
  // editable. Surviving items keep their engine `index`, so a mutator target
  // is never desynced by the filter.
  const visible = (listing.images ?? []).filter((image) => !image.clipped);
  return visible.map((image) => ({
    index: image.index,
    nested: Boolean(image.nested),
    rect: pdfRectToDisplay(image.rect, geometry.box, geometry.bakedRotate),
    matrix: image.matrix,
    opacity: typeof image.opacity === 'number' ? image.opacity : 1,
    blend: typeof image.blend === 'string' && image.blend ? image.blend : 'Normal',
    mask:
      image.mask &&
      (image.mask.kind === 'linear' || image.mask.kind === 'radial') &&
      Array.isArray(image.mask.from) &&
      Array.isArray(image.mask.to)
        ? {
            kind: image.mask.kind,
            from: [image.mask.from[0], image.mask.from[1]],
            to: [image.mask.to[0], image.mask.to[1]],
            startAlpha: image.mask.start_alpha,
            endAlpha: image.mask.end_alpha,
          }
        : null,
    kind: image.kind === 'inline' ? 'inline' : image.kind === 'vector' ? 'vector' : 'xobject',
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
