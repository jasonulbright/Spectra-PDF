// Durable page/document identity (Phase 5, roadmap § F — design in
// architecture/22-phase5-durable-identity.md).
//
// Two halves, both pure so they test without pdf.js:
//
// 1. GENERATION-TAGGED positional ids. Positional ids are re-derived on
//    every rebuild and were historically REUSED (`path#p2` came back
//    naming different content), which is why every id holder had to
//    hard-clear instead of prune — a stale id could re-bind to the wrong
//    physical page. Minting each positional index under a fresh per-path
//    generation makes stale matches IMPOSSIBLE by construction: after a
//    non-authored rebuild nothing survives, which is exactly the old
//    behavior, now enforced structurally.
//
// 2. AUTHORED-IDENTITY adoption. The JS page-tier commit builds the new
//    file FROM the pre-commit PageRefs, so it knows the old→new mapping;
//    `planCommit` publishes it and the post-commit reindex adopts the
//    old ids onto the FRESHLY-READ pages (ids only — dims/rotation/
//    annotations come from reading the baked bytes; the § F rotation
//    width/height swap is automatic that way). Validity is keyed on
//    BUFFER IDENTITY: the record names the exact committed buffer, so
//    any later buffer change makes it inert with no cleanup required.

import type { OpenDocument, PdfBuffer } from '../state/types';

/** The identity a commit authored for one file, carried on the
 * COMMIT_PAGE_EDITS update and stored on the file entry. */
export interface AuthoredIdentity {
  /** THE committed buffer object — adoption applies only while the
   * file's live buffer IS this object. */
  buffer: PdfBuffer;
  /** Old PageRef.id per new-file page position (whole file, in order). */
  pages: string[];
  /** Old OpenDocument.id per authored partition, in order. */
  documents: { id: string; name: string }[];
}

const generations = new Map<string, number>();

/** Bump and return the path's positional-index generation. Session
 * scoped — ids never persist to disk, and a reopen is a new world. */
export function nextGeneration(path: string): number {
  const next = (generations.get(path) ?? 0) + 1;
  generations.set(path, next);
  return next;
}

/** Test seam: forget all generations. */
export function resetGenerations(): void {
  generations.clear();
}

export function positionalPageId(path: string, generation: number, pageIndex: number): string {
  return `${path}#g${generation}#p${pageIndex}`;
}

export function positionalDocId(path: string, generation: number, docIndex: number): string {
  return `${path}#g${generation}#${docIndex}`;
}

/** Adopt authored ids onto a freshly-indexed document list, in place of
 * the positional ids. Fails CLOSED to positional on any shape mismatch
 * (page/document count divergence would mean the manifest and the plan
 * disagreed — impossible by construction, so treat the record as inert
 * rather than half-apply it). Returns the input array untouched when the
 * record does not apply. */
export function adoptAuthoredIdentity(
  docs: OpenDocument[],
  record: AuthoredIdentity | undefined,
  liveBuffer: PdfBuffer | null,
): OpenDocument[] {
  if (!record || liveBuffer === null || record.buffer !== liveBuffer) return docs;
  const totalPages = docs.reduce((sum, d) => sum + d.pages.length, 0);
  if (record.pages.length !== totalPages || record.documents.length !== docs.length) {
    return docs;
  }
  let cursor = 0;
  return docs.map((doc, docIndex) => ({
    ...doc,
    id: record.documents[docIndex].id,
    pages: doc.pages.map((page) => ({ ...page, id: record.pages[cursor++] })),
  }));
}

/** Resolve the PageRef.id at a 1-based page number within a path's
 * committed order (the inverse of workspacePageNumber). Replaces the one
 * historic site that STRING-BUILT `${path}#p${n-1}` — under generations
 * and adoption, ids are opaque and must be resolved from state. */
export function pageIdAtNumber(
  docs: OpenDocument[],
  path: string,
  pageNumber: number,
): string | null {
  let remaining = pageNumber;
  for (const d of docs) {
    if (d.path !== path) continue;
    if (remaining <= d.pages.length) return d.pages[remaining - 1]?.id ?? null;
    remaining -= d.pages.length;
  }
  return null;
}
