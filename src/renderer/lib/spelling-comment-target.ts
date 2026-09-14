import type { AppState, PageAnnotation } from '../state/types';
import type { SpellIssue } from './spellcheck';

export interface SpellingCommentTarget {
  docId: string;
  pageId: string;
  annotationId: string;
  annotation: PageAnnotation;
}

/** Report pages are physical, one-based indices across ALL file partitions.
 * The engine's document-global annotation ordinal is not a renderer index.
 * Equal text on another page, or an ambiguous fingerprint, proves no target. */
export function spellingCommentTarget(state: AppState, path: string, issue: SpellIssue): SpellingCommentTarget | null {
  if (!Number.isSafeInteger(issue.page) || issue.page! < 1 || !Number.isSafeInteger(issue.annotation)
      || issue.annotation! < 0 || typeof issue.annotation_text !== 'string') return null;
  let offset = issue.page! - 1;
  for (const doc of state.workspace.documents) {
    if (doc.path !== path) continue;
    if (offset >= doc.pages.length) { offset -= doc.pages.length; continue; }
    const page = doc.pages[offset];
    const matches = (page.annotations ?? []).filter(annotation => {
      if (annotation.note !== issue.annotation_text) return false;
      const imported = annotation.importedOriginal;
      if (issue.subtype && imported?.subtype !== issue.subtype) return false;
      if (issue.annotation_rect) {
        if (issue.annotation_rect.length !== 4 || !issue.annotation_rect.every(Number.isFinite)) return false;
        if (!imported || !imported.rect.every((n, i) => n === issue.annotation_rect![i])) return false;
      }
      return true;
    });
    if (matches.length !== 1) return null;
    return { docId: doc.id, pageId: page.id, annotationId: matches[0].id, annotation: matches[0] };
  }
  return null;
}
