// One ordered publication lane for page commits and disk history. A caller
// captures its revision INSIDE the lane, never in an older render callback.
//
// Every outstanding publication is recorded with the working paths it may
// replace; `null` means any path. A publisher that waits for a file lock
// before the lane announces itself from its claim on, so a path-scoped commit
// gate that names one of its paths waits for it although it is not in the
// lane yet.
interface Outstanding { paths: ReadonlySet<string> | null; settled: Promise<void> }

let tail: Promise<unknown> = Promise.resolve();
const outstanding = new Set<Outstanding>();

function names(entry: Outstanding, paths: readonly string[] | undefined): boolean {
  if (!paths || !entry.paths) return true;
  return paths.some(path => entry.paths!.has(path));
}

/** Whether a publication is outstanding; with `paths`, one that may replace
 * one of them. */
export function hasWorkspacePublication(paths?: readonly string[]): boolean {
  for (const entry of outstanding) if (names(entry, paths)) return true;
  return false;
}

/** Resolves once every publication outstanding now that may replace one of
 * `paths` (any, without `paths`) has finished, whatever its outcome.
 * Publications announced later are not awaited. */
export function workspacePublicationsSettled(paths?: readonly string[]): Promise<void> {
  const pending = Array.from(outstanding, entry => (names(entry, paths) ? entry.settled : null))
    .filter((p): p is Promise<void> => p !== null);
  return Promise.all(pending).then(() => {});
}

/** Records a publication of `paths` until the returned function runs. */
export function announceWorkspacePublication(paths: readonly string[] | null): () => void {
  let finish!: () => void;
  const entry: Outstanding = {
    paths: paths ? new Set(paths) : null,
    settled: new Promise<void>(resolve => { finish = resolve; }),
  };
  outstanding.add(entry);
  return () => {
    if (!outstanding.delete(entry)) return;
    finish();
  };
}

/** Runs `run` in the lane, after every earlier lane holder. It is recorded as
 * a publication of `paths` (`null`: any path) from this call until it settles. */
export function serializeWorkspacePublication<T>(run: () => Promise<T>,
  paths: readonly string[] | null = null): Promise<T> {
  const done = announceWorkspacePublication(paths);
  const result = tail.then(run);
  tail = result.then(() => {}, () => {}).finally(done);
  return result;
}
