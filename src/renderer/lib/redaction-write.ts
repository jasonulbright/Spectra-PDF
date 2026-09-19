import type { AppState, PageRef } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import { tChrome } from '../i18n';
import { captureFileOperationIntent } from './operation-intent';
import {
  buildRedactionRegions, EMPTY_MARK_LEDGER, marksAcross, wroteBytes,
  type PageGeometry, type RedactionMark,
} from './redaction';

export function groupRedactionMarks(state: AppState, marks: readonly RedactionMark[]) {
  const holders = new Map(state.workspace.documents.flatMap(doc => doc.pages.map(page => [page.id, doc.path] as const)));
  const groups = new Map<string, { path: string; marks: RedactionMark[]; markIds: string[] }>();
  for (const mark of marks) {
    const path = holders.get(mark.pageId);
    if (!path) throw new Error(tChrome('app.history.changed'));
    const group = groups.get(path) ?? { path, marks: [], markIds: [] };
    group.marks.push(mark);
    group.markIds.push(mark.id);
    groups.set(path, group);
  }
  return [...groups.values()];
}

/** Marks name physical pages; engine regions name positions in committed
 * bytes. Convert only after the commit, while the operation owns its source. */
export async function writeRedactionMarks(
  path: string, marks: readonly RedactionMark[], seen: AppState,
  method: 'redact' | 'save_redaction_marks', getState: () => AppState,
  perform: PerformOperation,
  geometry: (page: PageRef, state: AppState) => Promise<PageGeometry>,
  gsPath: () => Promise<string>,
): Promise<boolean> {
  const current = getState();
  const source = current.files.get(path);
  const original = seen.files.get(path);
  const changed = () => new Error(tChrome('app.history.changed'));
  if (!source || !original) throw changed();
  // Clearing a saved set has no page IDs to prove identity. Accept only the
  // original bytes or the single authored commit that the batch flushed.
  if (!marks.length && source.buffer !== original.buffer
      && source.authoredIdentity?.sourceBuffer !== original.buffer) throw changed();
  const intent = captureFileOperationIntent(current, source);
  const params = method === 'redact' ? { gs_path: await gsPath() } : {};
  const result = await perform(path, method, params, {
    intent,
    prepareParams: async accepted => {
      const carried = marksAcross({ ...EMPTY_MARK_LEDGER, marks: [...marks] }, seen, accepted).marks;
      if (carried.length !== marks.length) throw changed();
      const payload = await buildRedactionRegions(accepted.workspace.documents, carried,
        page => geometry(page, accepted));
      if (payload.skippedMarkIds.length || payload.files.some(file => file.path !== path)) throw changed();
      return { regions: payload.files[0]?.regions ?? [] };
    },
  });
  return wroteBytes(result);
}
