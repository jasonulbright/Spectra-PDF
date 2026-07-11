// Pending visible-signature placement and its conversion into the engine's
// `sign_pdf` appearance payload. A placement is TRANSIENT VIEW STATE owned by
// WorkspaceCanvasView with exactly the redaction-mark lifecycle (see
// lib/redaction.ts for the full rationale): it never enters the page-edit
// tier, dies when its file's buffer identity changes or the canvas unmounts,
// and resolves its page by pageId so it follows in-memory moves. Unlike
// redaction marks there is at most ONE placement — drawing again replaces it.
// Design notes: docs/architecture/13-phase2k-signature-completeness.md.
import { displayRectToPdf } from './pdfx-build';
import { workspacePageNumber } from './workspace-commit';
import type { PageGeometry } from './redaction';
import type { OpenDocument, PageRef } from '../state/types';

export interface SignaturePlacement {
  id: string;
  // File path at draw time — used only for buffer-identity invalidation.
  path: string;
  pageId: string;
  // Display-normalized (0..1 of the page cell) in the orientation shown at
  // draw time (baked /Rotate composed with the in-memory rotation).
  rect: { x: number; y: number; w: number; h: number };
  // In-memory rotation DELTA at draw time (the baked half is read from the
  // file at sign time and composed there — storing the composition would
  // double-count it; same contract as RedactionMark.rotationAtDraw).
  rotationAtDraw: 0 | 90 | 180 | 270;
}

export interface SignatureAppearance {
  page: number; // 1-based position within the file's committed order
  rect: [number, number, number, number]; // PDF user-space points, bottom-up
}

// Resolve the placement against the current workspace: which file to sign and
// where the stamp goes in PDF user space. Returns null when the placement's
// page no longer exists (deleted since it was drawn) — callers surface that,
// never guess. Conversion contract matches buildRedactionRegions exactly:
// displayRectToPdf against the CURRENT buffer's geometry at (bakedRotate +
// rotationAtDraw) — the orientation the rect was drawn in; a later in-memory
// rotation changes only the overlay projection, not the user-space rect.
export async function buildSignatureAppearance(
  docs: OpenDocument[],
  placement: SignaturePlacement,
  getGeometry: (page: PageRef, path: string) => Promise<PageGeometry>,
): Promise<{ path: string; appearance: SignatureAppearance } | null> {
  let doc: OpenDocument | undefined;
  let page: PageRef | undefined;
  for (const d of docs) {
    const p = d.pages.find((pg) => pg.id === placement.pageId);
    if (p) {
      doc = d;
      page = p;
      break;
    }
  }
  const pageNumber = doc && page ? workspacePageNumber(docs, doc, placement.pageId) : null;
  if (!doc || !page || pageNumber == null) return null;
  const { box, bakedRotate } = await getGeometry(page, doc.path);
  const rect = displayRectToPdf(placement.rect, box, bakedRotate + placement.rotationAtDraw);
  return { path: doc.path, appearance: { page: pageNumber, rect } };
}
