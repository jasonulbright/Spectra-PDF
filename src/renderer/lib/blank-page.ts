import { PDFDocument } from 'pdf-lib';

// Insert Blank Page (§ 9.3): generate a one-blank-page PDF, sized to the
// insertion neighbor, and hand it to the EXISTING byte-only import machinery
// (REGISTER_IMPORT_SOURCE + IMPORT_PAGES via App.importFilesIntoDoc) — which
// makes it undoable page-tier work with zero new commit paths. This module
// only builds the bytes; the anchor question is `state/selectors.insertAnchor`.

/** US Letter, the fallback when a document has no neighbor to copy (never
 * reachable through the menu — zero-page files can't exist — but the function
 * contract shouldn't depend on that). */
export const DEFAULT_PAGE_SIZE: [number, number] = [612, 792];

/**
 * A single blank page of the given size (PDF points, width × height as the
 * page will DISPLAY — the caller passes the neighbor's PageRef dims, which
 * are pdf.js viewport dims with the file's own /Rotate already baked in, so
 * the new page matches what the user sees beside it).
 */
export async function buildBlankPagePdf(
  width: number = DEFAULT_PAGE_SIZE[0],
  height: number = DEFAULT_PAGE_SIZE[1],
): Promise<Uint8Array> {
  const w = Number.isFinite(width) && width > 0 ? width : DEFAULT_PAGE_SIZE[0];
  const h = Number.isFinite(height) && height > 0 ? height : DEFAULT_PAGE_SIZE[1];
  const doc = await PDFDocument.create();
  doc.addPage([w, h]);
  return doc.save();
}
