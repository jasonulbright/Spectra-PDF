// The lifetime rules for what a field-script sandbox derives.
//
// A script-calculated value and a Format action's display string belong to ONE
// read of ONE document: the seed carried that document's fields and its /CO. A
// reread (new bytes, a commit, a rename) or a close ends that read, and a
// derived value that outlives it is drawn over a document that never computed
// it. There is no DOM test environment, so the rules live here rather than in
// the hook.

/** Which paths lost their sandbox: the field identity changed, or the path is
 * no longer a form this workspace holds. Identity is the fields ARRAY, the same
 * reference the workspace indexer publishes — a rebuilt list is a new read. */
export function staleScriptPaths<F>(
  sessionFields: ReadonlyMap<string, F>,
  currentFields: ReadonlyMap<string, F>,
): Set<string> {
  const out = new Set<string>();
  for (const [path, fields] of sessionFields) {
    const current = currentFields.get(path);
    if (current === undefined || current !== fields) out.add(path);
  }
  return out;
}

/**
 * Keep only what a live read still stands behind: a path survives when the
 * workspace still holds that form AND its session was not just dropped.
 * Returns `prev` unchanged when nothing is purged, so a React state setter can
 * bail out of a re-render.
 */
export function pruneScriptValues<T>(
  prev: ReadonlyMap<string, ReadonlyMap<string, T>>,
  keep: ReadonlySet<string>,
  drop: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlyMap<string, T>> {
  let changed = false;
  const next = new Map(prev);
  for (const path of prev.keys()) {
    if (keep.has(path) && !drop.has(path)) continue;
    next.delete(path);
    changed = true;
  }
  return changed ? next : prev;
}

/**
 * Whether a dispatch's result may be folded back in. A dispatch outlives a
 * reread; the session generation is the session OBJECT itself, so a late answer
 * from a disposed sandbox is refused rather than repopulating the values the
 * reread just purged.
 */
export function resultIsCurrent<E>(
  sessions: ReadonlyMap<string, E>,
  path: string,
  dispatched: E,
): boolean {
  return sessions.get(path) === dispatched;
}
