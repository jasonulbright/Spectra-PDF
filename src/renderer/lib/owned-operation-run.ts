import type { AppAction, AppState, OpenFile } from '../state/types';
import type { FillFormValues, PerformOperation } from '../hooks/useOperations';
import type { FormFillOptions } from './form-fill-transaction';
import type { FormFieldValue } from './forms';
import type { OperationOptions } from './operation-transaction';
import type { OpMethod } from './op-edit-class';
import { captureOperationIntent, assertOperationIntent, assertOperationGateResult, type OperationIntent } from './operation-intent';
import { tChrome } from '../i18n';

/** A write owns its gesture, then its transaction, then its exact publication.
 * Unlike a read run, its own commit/publication must not invalidate its result. */
export function createOwnedOperationRuns(readState: () => AppState) {
  let mounted = true, epoch = 0, active: object | null = null;
  const begin = (file: OpenFile | null) => {
    const state = readState();
    if (!mounted || active || !file?.buffer || file.importOnly
        || state.activeFileId !== file.path || state.files.get(file.path) !== file) return null;
    let intent = captureOperationIntent(state, file);
    const ticket = {}, lifetime = epoch;
    active = ticket;
    let abandoned = false, started = false, publication: OpenFile | undefined, readIntent: OperationIntent | undefined;
    const visible = () => mounted && lifetime === epoch && active === ticket && !abandoned
      && readState().activeFileId === file.path
      && readState().files.get(file.path)?.workingPath === file.workingPath;
    const assertActive = () => { if (!visible()) throw new Error(tChrome('app.history.changed')); };
    const assertSource = () => { assertActive(); assertOperationIntent(readState(), intent); };
    return {
      get source() { return readIntent?.source ?? intent.source; },
      get pageCount() { return intent.pageCount; },
      assertSource,
      /** Only for clearing this ticket's transient UI after revision drift;
       * never sufficient authority to read or mutate document contents. */
      ownsSession: visible,
      /** Immutable input inspection does not commit pending edits or consume
       * consent. Only a clean, owned revision can supply derived parameters. */
      assertCleanSource: () => {
        assertSource();
        if (readState().pageDirtyPaths.includes(file.path)) throw new Error(tChrome('app.history.changed'));
      },
      visible: () => visible() && (!readIntent || readState().files.get(file.path)?.buffer === readIntent.source.buffer
        && !readState().pageDirtyPaths.includes(file.path))
        && (!publication || readState().files.get(file.path)?.buffer === publication.buffer
        && !readState().pageDirtyPaths.includes(file.path)),
      synchronize: () => { if (!visible()) abandoned = true; },
      /** Exclusive read arm for an operation's preview. This consumes the
       * ticket: it can never subsequently be used to write without consent. */
      prepareRead: async (commit: () => Promise<void>) => {
        assertActive();
        if (started) throw new Error(tChrome('app.history.changed'));
        assertOperationIntent(readState(), intent);
        started = true;
        await commit();
        assertActive();
        const now = readState(), current = now.files.get(file.path);
        if (!current || now.pageDirtyPaths.includes(file.path)) throw new Error(tChrome('app.history.changed'));
        assertOperationGateResult(current, intent);
        readIntent = captureOperationIntent(now, current);
      },
      assertReadCurrent: () => {
        assertActive();
        if (!readIntent || readState().pageDirtyPaths.includes(file.path)) throw new Error(tChrome('app.history.changed'));
        assertOperationIntent(readState(), readIntent);
      },
      perform: async (operation: PerformOperation, method: OpMethod, params: Record<string, unknown>,
        options: OperationOptions = {}) => {
        assertActive();
        if (started) throw new Error(tChrome('app.history.changed'));
        assertOperationIntent(readState(), intent);
        started = true;
        const result = await operation(file.path, method, params, { ...options, intent,
          assertActive: () => { assertActive(); options.assertActive?.(); } });
        if (result && typeof result === 'object' && 'publication' in result) publication = result.publication;
        return result;
      },
      fill: async (fill: FillFormValues, values: Record<string, FormFieldValue>, options: FormFillOptions = {}) => {
        assertSource();
        if (started) throw new Error(tChrome('app.history.changed'));
        started = true;
        const result = await fill(file.path, values, { ...options, intent,
          assertActive: () => { assertActive(); options.assertActive?.(); } });
        if (typeof result === 'object' && result.completed) publication = result.publication;
        return result;
      },
      /** A multi-instance correction can advance only from its own returned
       * publication, never by sampling whichever revision became current. */
      continueAfterPublication: () => {
        assertActive();
        const now = readState();
        if (readIntent) throw new Error(tChrome('app.history.changed'));
        if (publication) {
          if (now.files.get(file.path) !== publication || now.pageDirtyPaths.includes(file.path)) {
            throw new Error(tChrome('app.history.changed'));
          }
          intent = captureOperationIntent(now, publication);
        } else assertSource();
        publication = undefined; started = false;
      },
      /** A synchronous annotation edit has no asynchronous publication
       * receipt. Prove the one reducer step before adopting its page tier. */
      editAnnotation: (dispatch: (action: AppAction) => void,
        target: { docId: string; pageId: string; annotationId: string }, expectedNote: string, note: string) => {
        assertSource();
        if (started) throw new Error(tChrome('app.history.changed'));
        const before = readState();
        const doc = before.workspace.documents.find(doc => doc.id === target.docId && doc.path === file.path);
        const annotation = doc?.pages.find(page => page.id === target.pageId)?.annotations?.find(a => a.id === target.annotationId);
        if (!annotation || (annotation.note ?? '') !== expectedNote) throw new Error(tChrome('app.history.changed'));
        if (note === expectedNote) return;
        dispatch({ type: 'UPDATE_ANNOTATION', docId: target.docId, pageId: target.pageId,
          annotationId: target.annotationId, note });
        const after = readState(), snapshot = after.pageUndoStack.at(-1);
        const edited = after.workspace.documents.find(doc => doc.id === target.docId)?.pages
          .find(page => page.id === target.pageId)?.annotations?.find(a => a.id === target.annotationId);
        if (after.files.get(file.path) !== intent.source || after.pageUndoStack.length !== before.pageUndoStack.length + 1
            || snapshot?.documents !== before.workspace.documents || snapshot.dirtyPaths !== before.pageDirtyPaths
            || edited?.note !== note) throw new Error(tChrome('app.history.changed'));
        intent = captureOperationIntent(after, intent.source);
      },
      finish: () => { if (active === ticket) active = null; },
    };
  };
  return { begin, activate: () => { mounted = true; epoch++; },
    deactivate: () => { mounted = false; epoch++; active = null; } };
}
export type OwnedOperationRun = NonNullable<ReturnType<ReturnType<typeof createOwnedOperationRuns>['begin']>>;
