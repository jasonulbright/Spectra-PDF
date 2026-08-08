import { createContext, useContext, type ReactNode } from 'react';
import type { NewFieldSpec } from '../lib/form-authoring';
import type { EditClass } from '../lib/signatures';

/** An undoable in-place workspace operation: snapshot the working copy, run the
 * engine op writing back to it, reload, and push an UPDATE_FILE undo entry.
 * This is App's `performOperation` — the SAME instance the canvas edit handlers
 * use — exposed to panels (which take no props) so an in-place op like
 * signing routes through the ONE flow instead of duplicating the snapshot/
 * commit choreography (and drifting from it). */
export type PerformOperation = (
  filePath: string,
  method: string,
  params: Record<string, unknown>,
) => Promise<void>;

/** Author N form fields as ONE undoable act — App's `handleAddFormFields`, the
 * same instance the canvas placement card calls. Field creation is renderer-side
 * pdf-lib rather than an engine method, so it cannot ride `performOperation`;
 * exposing the handler here is what keeps the panel off a second creation path. */
export type AddFormFields = (
  filePath: string,
  specs: readonly NewFieldSpec[],
) => Promise<void>;

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
