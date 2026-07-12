// Canvas whole-document merge (2o): pure helpers for the DocHeader merge-up
// action and its close-guard. Design: docs/architecture/17-phase2o-canvas-merge.md.
//
// A merge appends a COPY of the source document's pages to the target via
// one IMPORT_PAGES dispatch (2n.3's machinery unchanged, one undo step) —
// copy, not move, because the reducer's zero-page guard forbids emptying a
// file's pages, and the copy semantic leaves the source strip visibly intact
// until the user removes it (post-commit, once the copies re-bake to the
// target's own file, closing the source is ordinary).
import type { OpenDocument, PageAnnotation, PageRef } from '../state/types';

// Fresh page-ref copies for splicing into another document. Ids must be
// fresh: `PageRef.id` is positional (`path#pN`) and a copy of an OPEN file's
// page would duplicate its strip's id, corrupting selection/drag/centerOn
// lookups (consumers treat the id as opaque, so a suffixed form is fine —
// only a file's own strip keeps canonical ids, which is what Find/outline
// jumps target). Annotations and tombstones are deep-copied — a shared
// array/object would mutate across documents on later edits.
export function buildMergedPageRefs(doc: OpenDocument): PageRef[] {
  return doc.pages.map((page) => {
    const copy: PageRef = {
      id: `${page.id}#m${crypto.randomUUID()}`,
      sourceDocId: page.sourceDocId,
      sourcePageIndex: page.sourcePageIndex,
      rotation: page.rotation,
      width: page.width,
      height: page.height,
    };
    if (page.annotations) {
      copy.annotations = page.annotations.map((a) => {
        const annotation: PageAnnotation = { ...a, id: crypto.randomUUID() };
        if (a.points) annotation.points = [...a.points];
        if (a.importedOriginal) {
          annotation.importedOriginal = { ...a.importedOriginal, rect: [...a.importedOriginal.rect] };
        }
        return annotation;
      });
    }
    if (page.removedImportedOriginals) {
      copy.removedImportedOriginals = page.removedImportedOriginals.map((f) => ({
        ...f,
        rect: [...f.rect],
      }));
    }
    return copy;
  });
}

// Whether any OTHER document's pages still read their bytes from `path` —
// the raw reference predicate.
export function pathReferencedByOtherDocs(docs: readonly OpenDocument[], path: string): boolean {
  return docs.some((d) => d.path !== path && d.pages.some((p) => p.sourceDocId === path));
}

// The close-guard's actual question: is closing `path` HAZARDOUS right now?
// A staged (uncommitted) merge copy points at the source FILE's bytes —
// closing it would orphan the refs and every later commit of the referencing
// document would throw in `bytesFor`. But that hazard only exists while the
// REFERENCING document's path is page-tier dirty: right after Apply changes
// there is a short async-reindex window where the old refs linger in the
// workspace with a CLEAN tier — no commit can ever consume them (commit only
// rebuilds dirty paths) and the in-flight reindex replaces them, so refusing
// there would be a spurious "Apply changes first" against a user who just
// did (live-caught by the merge e2e).
export function pathBlockedFromClose(
  docs: readonly OpenDocument[],
  dirtyPaths: readonly string[],
  path: string,
): boolean {
  return docs.some(
    (d) =>
      d.path !== path &&
      dirtyPaths.includes(d.path) &&
      d.pages.some((p) => p.sourceDocId === path),
  );
}
