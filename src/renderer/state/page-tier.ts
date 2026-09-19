import type { PageEditSnapshot, PageTierStacks } from './types';

/**
 * The entries pushed onto the undo stack since `planned` was read, or null
 * when the live stacks are not a forward extension of it.
 *
 * Forward edits only push, so a live undo stack that starts with every planned
 * entry, by reference, and has an empty redo stack holds exactly the planned
 * edits plus the new ones. Anything else (an undo, a redo, a reset of the
 * stacks) leaves no record of which edits the plan contains.
 */
export function editsSincePlan(
  live: PageTierStacks,
  planned: PageTierStacks,
): PageEditSnapshot[] | null {
  if (live.pageUndoStack === planned.pageUndoStack && live.pageRedoStack === planned.pageRedoStack) {
    return [];
  }
  const depth = planned.pageUndoStack.length;
  if (live.pageRedoStack.length > 0 || live.pageUndoStack.length <= depth) return null;
  for (let i = 0; i < depth; i++) {
    if (live.pageUndoStack[i] !== planned.pageUndoStack[i]) return null;
  }
  return live.pageUndoStack.slice(depth);
}
