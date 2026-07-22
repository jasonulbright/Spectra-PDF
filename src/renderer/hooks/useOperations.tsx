import { createContext, useContext, type ReactNode } from 'react';

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

interface OperationsValue {
  performOperation: PerformOperation;
}

const OperationsContext = createContext<OperationsValue | null>(null);

export function OperationsProvider({
  performOperation,
  children,
}: {
  performOperation: PerformOperation;
  children: ReactNode;
}): React.ReactElement {
  return (
    <OperationsContext.Provider value={{ performOperation }}>{children}</OperationsContext.Provider>
  );
}

export function useOperations(): OperationsValue {
  const ctx = useContext(OperationsContext);
  if (!ctx) throw new Error('useOperations must be used within an OperationsProvider.');
  return ctx;
}
