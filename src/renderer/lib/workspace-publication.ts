// One ordered publication lane for page commits and disk history. A caller
// captures its revision INSIDE the lane, never in an older render callback.
//
// Every outstanding publication is recorded with the working paths it may
// replace; `null` means any path. A publisher that waits for a file lock
// before the lane announces itself from its claim on, so a path-scoped commit
// gate that names one of its paths waits for it although it is not in the
// lane yet. Announcements are ranked in the order they were made: a publisher
// whose own gate runs after its announcement waits only for older ones, so
// two publishers of one path never wait for each other.
interface Outstanding { paths: ReadonlySet<string> | null; settled: Promise<void>; order: number }

/** An announcement handle; `order` ranks it among all announcements. */
export type Announcement = (() => void) & { order: number };

let tail: Promise<unknown> = Promise.resolve();
const outstanding = new Set<Outstanding>();
let announced = 0;

function names(entry: Outstanding, paths: readonly string[] | undefined, before: number): boolean {
  if (entry.order >= before) return false;
  if (!paths || !entry.paths) return true;
  return paths.some(path => entry.paths!.has(path));
}

/** Whether a publication is outstanding; with `paths`, one that may replace
 * one of them; with `before`, one announced before that order. */
export function hasWorkspacePublication(paths?: readonly string[], before = Infinity): boolean {
  for (const entry of outstanding) if (names(entry, paths, before)) return true;
  return false;
}

/** Resolves once every publication outstanding now that may replace one of
 * `paths` (any, without `paths`), announced before `before`, has finished,
 * whatever its outcome. Publications announced later are not awaited. */
export function workspacePublicationsSettled(paths?: readonly string[], before = Infinity): Promise<void> {
  const pending = Array.from(outstanding, entry => (names(entry, paths, before) ? entry.settled : null))
    .filter((p): p is Promise<void> => p !== null);
  return Promise.all(pending).then(() => {});
}

/** Records a publication of `paths` until the returned function runs. */
export function announceWorkspacePublication(paths: readonly string[] | null): Announcement {
  let finish!: () => void;
  const entry: Outstanding = {
    paths: paths ? new Set(paths) : null,
    settled: new Promise<void>(resolve => { finish = resolve; }),
    order: ++announced,
  };
  outstanding.add(entry);
  return Object.assign(() => {
    if (!outstanding.delete(entry)) return;
    finish();
  }, { order: entry.order });
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
