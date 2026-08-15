// A one-slot "select this structure element when the Tags panel opens on THIS
// document".
//
// The accessibility report addresses a `struct` finding by a tree path, and
// the surface that shows a tree path is the Tags panel next door. Switching to
// it only SCHEDULES the op change, so the panel is not mounted for the rest of
// that synchronous run and there is nothing to call — the same shape
// `commands/find-intent.ts` documents for the canvas find bar. So park the
// intent and let the panel's own load drain it.
//
// The park is KEYED TO ITS DOCUMENT and drains only onto that document: a
// forgotten request cannot ambush a file opened later. A path never outlives
// the tree it was read from, so a path that no longer resolves selects nothing
// and says so — it never retargets, which is the stale-address rule this
// report follows everywhere.

interface Parked {
  document: string;
  /** The element's path in `get_struct_tree`'s numbering — the numbers, not a
   * rendered key, so the panel derives its own ancestors rather than parsing
   * a string back into a path. */
  path: readonly number[];
}

let parked: Parked | null = null;

/** Ask for `path` to be selected in the Tags panel showing `document`. */
export function parkStructSelection(document: string, path: readonly number[]): void {
  parked = { document, path: [...path] };
}

/** Take the parked path if it was taken for `document`. Returns null
 * otherwise, and leaves a park for a different document alone. */
export function drainStructSelection(document: string | null): number[] | null {
  if (!parked || document === null || parked.document !== document) return null;
  const path = [...parked.path];
  parked = null;
  return path;
}

/** Test seam: drop a parked request so cases can't leak into each other. */
export function resetStructSelection(): void {
  parked = null;
}
