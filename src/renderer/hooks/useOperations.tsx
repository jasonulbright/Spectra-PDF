import { createContext, useContext, type ReactNode } from 'react';
import type { NewFieldSpec } from '../lib/form-authoring';
import type { EDIT_DECLINED } from '../lib/edit-text';
import type { OpMethod } from '../lib/op-edit-class';
import type { EditClass } from '../lib/signatures';
import type { EngineResult } from './useEngine';

/** An undoable in-place workspace operation: snapshot the working copy, run the
 * engine op writing back to it, reload, and push an UPDATE_FILE undo entry.
 * This is App's `performOperation` — the SAME instance the canvas edit handlers
 * use — exposed to panels (which take no props) so an in-place op like
 * signing routes through the ONE flow instead of duplicating the snapshot/
 * commit choreography (and drifting from it).
 *
 * Resolves with the ENGINE's own answer, not with nothing: an operation that
 * reports what it could not do — a partial conversion, a count of what changed
 * — has no other way to reach the surface that must say so, and a caller
 * holding only `void` can state only what it asked for. `null` means the path
 * named no open file, so no operation ran.
 *
 * `EDIT_DECLINED` means the SIGNED-DOCUMENT decision stopped it: this flow
 * takes that decision itself, from the op's own class (`lib/op-edit-class`),
 * so no surface has to remember to ask and none can forget. Distinct from
 * `null` and from a throw because a caller showing "Applying…" has to know
 * which of the three happened — a silent return is visually indistinguishable
 * from success.
 *
 * `method` is the roster's key type, not `string`: an operation added without
 * an edit class does not compile. */
export type PerformOperation = (
  filePath: string,
  method: OpMethod,
  params: Record<string, unknown>,
) => Promise<EngineResult | null | typeof EDIT_DECLINED>;

/** Author N form fields as ONE undoable act — App's `handleAddFormFields`, the
 * same instance the canvas placement card calls. Field creation is renderer-side
 * pdf-lib rather than an engine method, so it cannot ride `performOperation`;
 * exposing the handler here is what keeps the panel off a second creation path.
 *
 * `EDIT_DECLINED` for the same reason `performOperation` returns it: the
 * signed-document decision refused or the user declined, and a caller that
 * reports "created N" on a resolved promise would report a creation that never
 * happened. */
export type AddFormFields = (
  filePath: string,
  specs: readonly NewFieldSpec[],
) => Promise<void | typeof EDIT_DECLINED>;

/** What a document's own signatures permit — App's `confirmEditOfSignedDoc`,
 * the same instance the canvas edit handlers use. A dialog that authors a
 * document change needs the SAME answer the canvas gets, so the decision has
 * one implementation rather than a second one per surface. Resolves false when
 * the edit is refused or the user declines. */
export type ConfirmSignedEdit = (
  filePath: string,
  workingPath: string,
  editClass: EditClass,
  fields?: readonly string[] | null,
  /** Of `fields`, the ones the caller actually named — the rest are what the
   * document's own calculations would change as a result. A lock that bites
   * only those has to say so, or a user told "Total is locked" after typing
   * into "Item 1" has been told nothing. */
  typed?: readonly string[] | null,
) => Promise<boolean>;

interface OperationsValue {
  performOperation: PerformOperation;
  addFormFields: AddFormFields;
  confirmSignedEdit: ConfirmSignedEdit;
}

const OperationsContext = createContext<OperationsValue | null>(null);

export function OperationsProvider({
  performOperation,
  addFormFields,
  confirmSignedEdit,
  children,
}: {
  performOperation: PerformOperation;
  addFormFields: AddFormFields;
  confirmSignedEdit: ConfirmSignedEdit;
  children: ReactNode;
}): React.ReactElement {
  return (
    <OperationsContext.Provider value={{ performOperation, addFormFields, confirmSignedEdit }}>
      {children}
    </OperationsContext.Provider>
  );
}

export function useOperations(): OperationsValue {
  const ctx = useContext(OperationsContext);
  if (!ctx) throw new Error('useOperations must be used within an OperationsProvider.');
  return ctx;
}
