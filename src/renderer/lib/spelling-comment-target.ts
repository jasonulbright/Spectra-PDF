import type { AppState, PageAnnotation } from '../state/types';
import type { SpellIssue } from './spellcheck';

export interface SpellingCommentTarget {
  docId: string;
  pageId: string;
  annotationId: string;
  annotation: PageAnnotation;
}

function normalized(rect: readonly number[]): [number, number, number, number] {
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
}

/**
 * Whether the engine's `/Rect` and the imported record describe one annotation.
 *
 * A `/Text` note's imported rect is not the file's: the viewer publishes a
 * sticky note as a fixed-size ICON box anchored at the rect's top-left corner,
 * so the two other edges carry the icon size and nothing about the file. That
 * corner is what both sides hold, and it is what separates two notes — two the
 * corner cannot separate sit at the same point, which no rect would separate
 * either. Every other subtype keeps the file's rect and compares whole.
 */
export function rectsMatch(
  fileRect: readonly number[],
  importedRect: readonly number[],
  subtype: string,
): boolean {
  if (importedRect.length !== 4 || !importedRect.every(Number.isFinite)) return false;
  const file = normalized(fileRect), imported = normalized(importedRect);
  if (subtype === 'Text') return file[0] === imported[0] && file[3] === imported[3];
  return file.every((n, i) => n === imported[i]);
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
        if (!imported || !rectsMatch(issue.annotation_rect, imported.rect, imported.subtype)) return false;
      }
      return true;
    });
    if (matches.length !== 1) return null;
    return { docId: doc.id, pageId: page.id, annotationId: matches[0].id, annotation: matches[0] };
  }
  return null;
}
