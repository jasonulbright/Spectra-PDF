// Pending-redaction marks and their conversion into the engine's `redact`
// payload. Marks are TRANSIENT VIEW STATE owned by WorkspaceCanvasView — they
// are deliberately NOT PageAnnotations and never enter the page-edit tier:
// the tier commits by rebuilding file bytes in the renderer, while redaction
// is an engine (Python) operation, and a reindex after any commit rebuilds
// PageRefs with POSITIONAL ids (`path#pN`), under which a surviving mark
// could silently re-bind to a different physical page — unacceptable for a
// destructive tool. Instead marks die with the canvas view and whenever their
// file's buffer identity changes (see WorkspaceCanvasView's invalidation
// effect); the apply path routes through App's performOperation so the
// commit gate materializes pending page edits first and the result lands on
// the snapshot undo chain. Design notes:
// docs/architecture/06-phase2d-redaction.md.
import { displayRectToPdf } from './pdfx-build';
import { workspacePageNumber } from './workspace-commit';
import type { OpenDocument, PageRef } from '../state/types';

export interface RedactionMark {
  id: string;
  // File path at draw time — used only to invalidate marks when that file's
  // buffer changes underneath them. Page resolution goes by pageId so a mark
  // follows its page through in-memory moves.
  path: string;
  pageId: string;
  // Display-normalized (0..1 of the page cell) in the orientation the page
  // was shown at draw time — i.e. the file's baked /Rotate composed with the
  // PageRef's in-memory rotation at that moment.
  rect: { x: number; y: number; w: number; h: number };
  rotationAtDraw: 0 | 90 | 180 | 270;
}

// Geometry of the page as it exists in the CURRENT file bytes, read from the
// pdf.js proxy at apply time. `box` is page.view (the crop-intersected box —
// the same box the annotation import/commit sides agreed on after the Phase
// 2c.3c drift fix); `bakedRotate` is page.rotate, the /Rotate already in the
// file, on top of which PageRef.rotation is a pending in-memory delta.
export interface PageGeometry {
  box: { x: number; y: number; width: number; height: number };
  bakedRotate: number;
}

export interface RedactionRegion {
  page: number; // 1-based position within the file's committed order
  rect: [number, number, number, number];
}

export interface RedactionFilePayload {
  path: string;
  regions: RedactionRegion[];
  markIds: string[];
}

// Rotate a display-normalized rect by a quarter-turn delta — the rect-only
// twin of the reducer's rotateAnnotationRect (tests/redaction.test.ts
// cross-checks the two case-by-case so they can't drift apart). Used to
// re-project a mark drawn at one rotation onto a page later rotated in
// memory: user space never moves under /Rotate, only the projection does.
export function rotateNormalizedRect(
  r: { x: number; y: number; w: number; h: number },
  delta: number,
): { x: number; y: number; w: number; h: number } {
  const d = ((delta % 360) + 360) % 360;
  if (d === 90) return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
  if (d === 180) return { x: 1 - (r.x + r.w), y: 1 - (r.y + r.h), w: r.w, h: r.h };
  if (d === 270) return { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
  return r;
}

// Where a mark should render on a page whose in-memory rotation has changed
// since the mark was drawn.
export function projectMarkRect(
  mark: RedactionMark,
  currentRotation: number,
): { x: number; y: number; w: number; h: number } {
  return rotateNormalizedRect(mark.rect, currentRotation - mark.rotationAtDraw);
}

// Resolve marks against the current workspace and produce one engine payload
// per affected file. A mark whose page no longer exists (deleted since it was
// drawn) is skipped and reported, never guessed at.
//
// Rect conversion: displayRectToPdf against the geometry's box at
// (bakedRotate + rotationAtDraw) — the orientation the rect was DRAWN in.
// The page's current in-memory rotation is irrelevant here: /Rotate never
// moves content in user space, so a later rotation changes only the overlay
// projection (projectMarkRect), not the user-space rect. After the commit
// gate bakes the pending delta, the content stream the engine walks is still
// the same user space this rect targets.
export async function buildRedactionRegions(
  docs: OpenDocument[],
  marks: RedactionMark[],
  getGeometry: (page: PageRef, path: string) => Promise<PageGeometry>,
): Promise<{ files: RedactionFilePayload[]; skippedMarkIds: string[] }> {
  const byPath = new Map<string, RedactionFilePayload>();
  const skippedMarkIds: string[] = [];
  for (const mark of marks) {
    let doc: OpenDocument | undefined;
    let page: PageRef | undefined;
    for (const d of docs) {
      const p = d.pages.find((pg) => pg.id === mark.pageId);
      if (p) {
        doc = d;
        page = p;
        break;
      }
    }
    const pageNumber = doc && page ? workspacePageNumber(docs, doc, mark.pageId) : null;
    if (!doc || !page || pageNumber == null) {
      skippedMarkIds.push(mark.id);
      continue;
    }
    const { box, bakedRotate } = await getGeometry(page, doc.path);
    const rect = displayRectToPdf(mark.rect, box, bakedRotate + mark.rotationAtDraw);
    let payload = byPath.get(doc.path);
    if (!payload) {
      payload = { path: doc.path, regions: [], markIds: [] };
      byPath.set(doc.path, payload);
    }
    payload.regions.push({ page: pageNumber, rect });
    payload.markIds.push(mark.id);
  }
  return { files: [...byPath.values()], skippedMarkIds };
}
