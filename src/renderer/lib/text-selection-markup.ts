// Authoring native text markup from a real text selection (N-cluster, the
// CREATE half — N1 shipped import + edit).
//
// The reading view already lays pdf.js's TextLayer over the raster, so the
// browser gives us a genuine DOM Range for whatever the user selected — with
// double-click-word and triple-click-line for free. A Range's client rects are
// ONE PER LINE BOX, which is exactly the shape /QuadPoints wants, so a
// selection converts to markup quads with no geometry of our own.
//
// Everything here is pure — rects in, annotations out — because there is no
// DOM test environment in this repo: the geometry is what can break, so the
// geometry is what must be testable without a browser.
import { rotateNormalizedPoints, type PageGeometry } from './redaction';
import { displayRectToPdf } from './pdfx-build';
import { workspacePageNumber } from './workspace-commit';
import type { OpenDocument, PageAnnotation, TextMarkupType } from '../state/types';

/** The parts of a DOMRect this module needs (so tests can pass plain objects). */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A mounted page cell: its identity and its on-screen box. */
export interface PageBox {
  docId: string;
  pageId: string;
  /** The page element's client rect — the DISPLAY frame (already view-rotated). */
  rect: RectLike;
}

/** Quads thinner/narrower than this fraction of the page are selection noise
 *  (collapsed ranges, zero-height line boxes) and are dropped. */
const MIN_SPAN = 0.0005;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const centerIn = (r: RectLike, box: RectLike): boolean => {
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
};

/**
 * One selection rect → a display-normalized quad [x0,y0,x1,y1] inside `box`,
 * or null when it is degenerate. Clamped to the page: a line box can overhang
 * the raster by a hair at some zooms, and a quad outside 0..1 would export as
 * /QuadPoints off the page.
 */
export function quadFromRect(r: RectLike, box: RectLike): number[] | null {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width <= 0 || height <= 0) return null;
  const x0 = clamp01((r.left - box.left) / width);
  const x1 = clamp01((r.right - box.left) / width);
  const y0 = clamp01((r.top - box.top) / height);
  const y1 = clamp01((r.bottom - box.top) / height);
  if (x1 - x0 < MIN_SPAN || y1 - y0 < MIN_SPAN) return null;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Bounding box of a flat [x0,y0,x1,y1,...] quad list. */
export function quadsBBox(quads: number[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < quads.length; i += 2) {
    minX = Math.min(minX, quads[i]);
    maxX = Math.max(maxX, quads[i]);
    minY = Math.min(minY, quads[i + 1]);
    maxY = Math.max(maxY, quads[i + 1]);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Rotate each quad's two corners by `delta`, then RE-ORDER them back to
 * (min,min)–(max,max). The re-order is what keeps a quad a quad: a rotated
 * top-left corner is no longer the smaller pair, and the commit builder reads
 * width as `x1 - x0` — an un-ordered quad exports with negative extents. This
 * is the reducer's own rule for real page rotations (state/reducer.ts
 * `rotateAnnotationRect`), applied at the capture edge.
 */
export function unprojectQuads(quads: number[], delta: number): number[] {
  const d = ((delta % 360) + 360) % 360;
  if (d === 0) return quads;
  const out: number[] = [];
  for (let i = 0; i + 3 < quads.length; i += 4) {
    const [ax, ay, bx, by] = rotateNormalizedPoints(
      [quads[i], quads[i + 1], quads[i + 2], quads[i + 3]],
      d,
    );
    out.push(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
  }
  return out;
}

export interface BuiltMarkup {
  docId: string;
  pageId: string;
  annotation: PageAnnotation;
}

export interface BuildMarkupInput {
  /** Client rects of the selection — `Range.getClientRects()`, in order. */
  rects: RectLike[];
  /** Every page cell currently on screen. */
  pages: PageBox[];
  markupType: TextMarkupType;
  color: string;
  /** Rotate View's render-only quarter-turn — quads are captured in the
   *  displayed frame and stored un-projected, exactly like every band. */
  viewRotation?: 0 | 90 | 180 | 270;
  /** Injected so tests get stable ids (the app passes crypto.randomUUID). */
  newId?: () => string;
}

export interface PageQuads {
  docId: string;
  pageId: string;
  /** Flat [x0,y0,x1,y1,...], stored frame (view rotation un-projected). */
  quads: number[];
}

/**
 * Partition a selection's line boxes by page and normalize them into stored-
 * frame quads. Shared by both things a selection can author: text markup
 * (annotation tier) and link regions (engine tier).
 */
export function selectionQuadsByPage(
  rects: RectLike[],
  pages: PageBox[],
  viewRotation: 0 | 90 | 180 | 270 = 0,
): PageQuads[] {
  const byPage = new Map<string, { page: PageBox; quads: number[] }>();
  for (const r of rects) {
    const page = pages.find((p) => centerIn(r, p.rect));
    if (!page) continue; // a rect outside every mounted page (scrolled away)
    const quad = quadFromRect(r, page.rect);
    if (!quad) continue;
    let entry = byPage.get(page.pageId);
    if (!entry) byPage.set(page.pageId, (entry = { page, quads: [] }));
    // pdf.js emits one rect per line box, but a range that starts and ends
    // inside the same line can yield duplicates — an exported duplicate quad
    // double-darkens a highlight, so drop exact repeats.
    const dup = (() => {
      for (let i = 0; i + 3 < entry.quads.length; i += 4) {
        if (
          entry.quads[i] === quad[0] &&
          entry.quads[i + 1] === quad[1] &&
          entry.quads[i + 2] === quad[2] &&
          entry.quads[i + 3] === quad[3]
        ) {
          return true;
        }
      }
      return false;
    })();
    if (!dup) entry.quads.push(...quad);
  }

  const inverseView = (360 - (viewRotation % 360)) % 360;
  const out: PageQuads[] = [];
  // Page order, not selection order, so multi-page results are deterministic.
  for (const page of pages) {
    const entry = byPage.get(page.pageId);
    if (!entry || entry.quads.length === 0) continue;
    out.push({
      docId: page.docId,
      pageId: page.pageId,
      quads: unprojectQuads(entry.quads, inverseView),
    });
  }
  return out;
}

/**
 * Build one text-markup annotation PER PAGE the selection touches. A drag
 * across a page break in the continuous reading view is an ordinary thing to
 * do, and a single annotation cannot span two pages — so the selection is
 * partitioned by which page each line box falls in, and each page gets its own
 * annotation carrying only its own quads.
 */
export function buildTextMarkupAnnotations({
  rects,
  pages,
  markupType,
  color,
  viewRotation = 0,
  newId = () => crypto.randomUUID(),
}: BuildMarkupInput): BuiltMarkup[] {
  const out: BuiltMarkup[] = [];
  for (const { docId, pageId, quads } of selectionQuadsByPage(rects, pages, viewRotation)) {
    // The bbox comes from the STORED quads — one source for both, so they
    // cannot drift (the ink stroke's rule).
    const box = quadsBBox(quads);
    if (box.w <= 0 && box.h <= 0) continue;
    out.push({
      docId,
      pageId,
      annotation: { id: newId(), kind: 'textmarkup', markupType, quads, ...box, color },
    });
  }
  return out;
}

// ── Link regions from the same selection ────────────────────────────────────
// A link is NOT an annotation in this app's model (it is engine-tier, like the
// Links manager), so authoring one takes the selection all the way to PDF user
// space instead of into the page tier. ONE LINK PER LINE BOX: a single Rect
// spanning a wrapped phrase would make the empty margin between lines
// clickable, which is not what the gesture asked for.

export interface LinkSpec {
  page: number; // 1-based position within the file's committed order
  rect: [number, number, number, number];
  url: string;
}

export interface LinkFilePayload {
  path: string;
  links: LinkSpec[];
}

/**
 * Resolve selection quads against the workspace and produce one engine payload
 * per affected file. Conversion contract matches `buildRedactionRegions`
 * exactly: `displayRectToPdf` against the geometry box at `bakedRotate +
 * page.rotation` — the orientation the quads were captured in. A page that has
 * vanished since the selection is skipped, never guessed at.
 */
export async function buildLinkPayloads(
  docs: OpenDocument[],
  selection: PageQuads[],
  url: string,
  getGeometry: (page: { sourceDocId: string; sourcePageIndex: number }, path: string) => Promise<PageGeometry>,
): Promise<{ files: LinkFilePayload[]; skippedPageIds: string[] }> {
  const byPath = new Map<string, LinkFilePayload>();
  const skippedPageIds: string[] = [];
  for (const entry of selection) {
    let doc: OpenDocument | undefined;
    let page: OpenDocument['pages'][number] | undefined;
    for (const d of docs) {
      const p = d.pages.find((pg) => pg.id === entry.pageId);
      if (p) {
        doc = d;
        page = p;
        break;
      }
    }
    const pageNumber = doc && page ? workspacePageNumber(docs, doc, entry.pageId) : null;
    if (!doc || !page || pageNumber == null) {
      skippedPageIds.push(entry.pageId);
      continue;
    }
    const { box, bakedRotate } = await getGeometry(page, doc.path);
    let payload = byPath.get(doc.path);
    if (!payload) byPath.set(doc.path, (payload = { path: doc.path, links: [] }));
    for (let i = 0; i + 3 < entry.quads.length; i += 4) {
      const rect = displayRectToPdf(
        {
          x: entry.quads[i],
          y: entry.quads[i + 1],
          w: entry.quads[i + 2] - entry.quads[i],
          h: entry.quads[i + 3] - entry.quads[i + 1],
        },
        box,
        bakedRotate + page.rotation,
      );
      payload.links.push({ page: pageNumber, rect, url });
    }
  }
  return { files: [...byPath.values()], skippedPageIds };
}
