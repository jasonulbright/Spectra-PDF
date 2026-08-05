import { createContext, useContext, type ReactNode } from 'react';
import type { NewFieldSpec } from '../lib/form-authoring';

/** An undoable in-place workspace operation: snapshot the working copy, run the
 * engine op writing back to it, reload, and push an UPDATE_FILE undo entry.
 * This is App's `performOperation` — the SAME instance the canvas edit handlers
 * use — exposed to panels (which take no props) so an in-place op like 9.F5
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

interface OperationsValue {
  performOperation: PerformOperation;
  addFormFields: AddFormFields;
}

const OperationsContext = createContext<OperationsValue | null>(null);

export function OperationsProvider({
  performOperation,
  addFormFields,
  children,
}: {
  performOperation: PerformOperation;
  addFormFields: AddFormFields;
  children: ReactNode;
}): React.ReactElement {
  return (
    <OperationsContext.Provider value={{ performOperation, addFormFields }}>
      {children}
    </OperationsContext.Provider>
  );
}

export function useOperations(): OperationsValue {
  const ctx = useContext(OperationsContext);
  if (!ctx) throw new Error('useOperations must be used within an OperationsProvider.');
  return ctx;
}
