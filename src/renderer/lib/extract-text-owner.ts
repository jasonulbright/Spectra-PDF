import type { AppState, OpenDocument, OpenFile } from '../state/types';

/** A canvas page number has meaning only in the view that supplied it. */
export interface CanvasTextRequest {
  file: OpenFile;
  page: number;
  documents: OpenDocument[];
}

export function captureCanvasTextRequest(state: AppState, path: string, page: number): CanvasTextRequest | null {
  const file = state.files.get(path);
  if (!file?.buffer || file.importOnly || !Number.isInteger(page) || page < 1) return null;
  const documents = state.workspace.documents.filter(doc => doc.path === path);
  if (documents.some(doc => doc.buffer !== file.buffer || doc.workingPath !== file.workingPath)) return null;
  if (page > documents.reduce((count, doc) => count + doc.pages.length, 0)) return null;
  return { file, page, documents };
}

export function canvasTextRequestCurrent(request: CanvasTextRequest, state: AppState): boolean {
  const file = state.files.get(request.file.path);
  const documents = state.workspace.documents.filter(doc => doc.path === request.file.path);
  return state.activeFileId === request.file.path && file?.workingPath === request.file.workingPath
    && file.buffer === request.file.buffer && documents.length === request.documents.length
    && documents.every((doc, index) => doc === request.documents[index]);
}

export interface TextExtractionDisplay {
  file: OpenFile;
  selection: string;
  value: string;
}

/** Display state survives an await, not a change of document, bytes or input. */
export function textExtractionDisplayCurrent(display: TextExtractionDisplay | null,
  state: AppState, selection: string, allowDirty = false): display is TextExtractionDisplay {
  if (!display || !display.file.buffer || selection !== display.selection) return false;
  const file = state.files.get(display.file.path);
  return state.activeFileId === display.file.path && file?.workingPath === display.file.workingPath
    && file.buffer === display.file.buffer && (allowDirty || !state.pageDirtyPaths.includes(display.file.path));
}
