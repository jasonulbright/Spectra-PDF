import type { PageEditSnapshot, PageTierStacks } from './types';

/**
 * Whether `now` records the same edits as `then`, in the same places.
 *
 * Entries compare by their action, never by the entry object or the stack
 * array: new bytes for a path the tier is independent of replace that path's
 * documents inside every entry and keep each action.
 */
export function sameEdits(now: readonly PageEditSnapshot[], then: readonly PageEditSnapshot[]): boolean {
  return now.length === then.length && now.every((entry, i) => entry.action === then[i].action);
}

/**
 * The entries pushed onto the undo stack since `planned` was read, or null
 * when the live stacks are not a forward extension of it.
 *
 * Forward edits only push, so a live undo stack that starts with every planned
 * action and has an empty redo stack holds exactly the planned edits plus the
 * new ones. Anything else (an undo, a redo, a reset of the stacks) leaves no
 * record of which edits the plan contains.
 */
export function editsSincePlan(
  live: PageTierStacks,
  planned: PageTierStacks,
): PageEditSnapshot[] | null {
  if (sameEdits(live.pageUndoStack, planned.pageUndoStack) && sameEdits(live.pageRedoStack, planned.pageRedoStack)) {
    return [];
  }
  const depth = planned.pageUndoStack.length;
  if (live.pageRedoStack.length > 0 || live.pageUndoStack.length <= depth) return null;
  if (!sameEdits(live.pageUndoStack.slice(0, depth), planned.pageUndoStack)) return null;
  return live.pageUndoStack.slice(depth);
}
