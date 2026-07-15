import type { AppState, OpenFile } from './types';

// Questions about the state that more than one layer needs to ask, answered
// once. A leaf: types only, so anything may import it.

/**
 * The active file's path, but only if it is a document the user can SEE.
 *
 * `state.activeFileId !== null` is NOT the same question. A byte-only import
 * source (`REGISTER_IMPORT_SOURCE` — pages dragged in from a file that was never
 * opened) is an entry in `files` with no tab, no strip, and no window; nothing
 * flips `importOnly` except `OPEN_FILE`.
 *
 * The reducer now refuses to make one active (`SET_ACTIVE_FILE` rejects a ghost;
 * `CLOSE_FILE`'s fallback skips them; `focusTab` and `UI_FOCUS_DOC` reject a
 * ghost target), so in principle every caller could just read `activeFileId`.
 * They ask this instead because the cost of the invariant being wrong is not
 * cosmetic: a ghost's `path` is the ORIGINAL file it was imported from, and File
 * ▸ Save writes the working copy back over `activeFile.path` with no dialog — so
 * a ghost reaching the active slot silently overwrites a real file on disk, with
 * no tab and no dirty marker to connect it to the action. That happened; this is
 * the guard that makes it fail safe instead.
 *
 * One implementation, so "which document can the user act on?" has one answer —
 * seven consumers had answered it separately, and four of them got it wrong.
 */
export function showableDoc(state: AppState): string | null {
  const path = state.activeFileId;
  if (!path) return null;
  const f = state.files.get(path);
  return f && !f.importOnly ? path : null;
}

/** `showableDoc`, resolved to the file itself. */
export function showableFile(state: AppState): OpenFile | null {
  const path = showableDoc(state);
  return path ? state.files.get(path) ?? null : null;
}

/** The open files that get tabs — byte-only import sources (2n.3) don't. */
export function tabFiles(state: AppState): OpenFile[] {
  return [...state.files.values()].filter((f) => !f.importOnly);
}
