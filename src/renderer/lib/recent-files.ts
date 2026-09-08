// Recent-files list (the `spectra-recent` localStorage key). Lives in the ui
// slice so the File ▸ Open Recent menu and the Home tab render it reactively.
// Every mutation commits storage under one cross-window lock and then
// dispatches the returned authoritative list; other windows adopt it through
// the storage event. readRecent is the one validated boot reader.
//
// Entries carry WHEN they were opened (the Home tab's opened-when
// column). Legacy
// bare-string entries migrate with `openedAt: null` — an honest "unknown",
// displayed as an em dash, never a fabricated date.

import { formattingLocale, tChrome } from '../i18n';

const KEY = 'spectra-recent';
// Clear Recent empties the list for every window at once, and it has to
// survive a cross-window merge that otherwise keeps the newest record of every
// path. A logical generation says WHICH mutation emptied the list, so a window
// still
// holding the pre-clear list mirrors nothing back and a file opened after the
// clear still counts.
// Its own key: the list stays a plain array, so a build that predates this
// reads it unchanged.
const CLEARED_KEY = 'spectra-recent-cleared';
const SEQ_KEY = 'spectra-recent-seq';
// Per-path removal has the same problem Clear Recent has — a merge that keeps
// the newest record of every path can never drop one — but it cannot use the
// clear's generation stamp, which is global. Tombstones are per path, and they
// are ordered against opens by `seq` rather than by wall clock, because a
// removal and a re-open can land in the same millisecond.
const REMOVED_KEY = 'spectra-recent-removed';
// When the bounded tombstone list evicts an old row, this floor prevents a
// window that has held the corresponding entry in memory from adding it back.
// It is applied only to entries ABSENT from the authoritative stored list, so
// compacting one removal never drops unrelated live entries.
const REMOVED_BEFORE_KEY = 'spectra-recent-removed-before';
const STORAGE_LOCK = 'spectra-recent-storage';
const MAX = 10;
/** Cap on exact per-path tombstones. Older rows compact into
 * REMOVED_BEFORE_KEY; compaction is therefore bounded without weakening a
 * removal. */
const REMOVED_MAX = 32;
// Epoch milliseconds are currently ~1.8e12. Values this close to JS's integer
// limit can only be corrupt/hostile storage and would leave no safe successor.
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER - 1_000_000;

export interface RecentEntry {
  path: string;
  /** Epoch ms of the last open; null for entries persisted before it was recorded. */
  openedAt: number | null;
  /**
   * The web address this entry was downloaded from (File ▸ Open from Web
   * Address). Display and re-open provenance only: `path` is a temporary copy
   * that may be gone, so re-opening one of these re-runs the download dialog
   * PRE-FILLED with this address. It is never fetched without the user
   * pressing Open again.
   */
  sourceUrl?: string;
  /**
   * A monotonic logical stamp (seeded from, but never ordered by, wall time —
   * see `nextRecentSeq`),
   * set whenever this entry is (re)opened. It orders an open against a removal
   * tombstone for the same path when both could land in the same millisecond,
   * and detects a re-open that raced an in-flight async liveness probe. Absent
   * on an entry persisted before this field existed, or on one nothing has
   * (re)opened since; an absent stamp is older than every tombstone, which is
   * correct because a tombstone can only postdate the field.
   */
  seq?: number;
}

function isSequence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_SEQUENCE
  );
}

// Pure, testable core: JSON-valid-but-wrong-shape (object, string, null) →
// [], never a non-array that would crash HomeTab's .map (regression).
// Accepts both shapes: the legacy string[] and the entry form.
export function parseRecent(raw: string | null): RecentEntry[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    const out: RecentEntry[] = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        out.push({ path: item, openedAt: null });
      } else if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { path?: unknown }).path === 'string' &&
        (item as { path: string }).path !== ''
      ) {
        const at = (item as { openedAt?: unknown }).openedAt;
        const from = (item as { sourceUrl?: unknown }).sourceUrl;
        const seq = (item as { seq?: unknown }).seq;
        out.push({
          path: (item as { path: string }).path,
          openedAt: typeof at === 'number' && Number.isFinite(at) ? at : null,
          // A stored address that is not a string is dropped rather than
          // coerced: it drives a pre-filled request, so a wrong shape must
          // read as "no provenance", never as an address.
          ...(typeof from === 'string' && from !== '' ? { sourceUrl: from } : {}),
          // A missing or wrong-shaped stamp omits the field rather than
          // defaulting to 0: 0 is a real, comparable stamp, and an entry
          // carrying one would read as ancient-but-recorded instead of
          // never-recorded.
          ...(isSequence(seq) ? { seq } : {}),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readStored(): RecentEntry[] {
  try {
    return parseRecent(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function readClearSeq(): number {
  try {
    const raw = Number(localStorage.getItem(CLEARED_KEY));
    return isSequence(raw) ? raw : 0;
  } catch {
    return 0;
  }
}

/**
 * Allocate a fresh, strictly increasing stamp. Production callers invoke this
 * while holding STORAGE_LOCK, which is what makes the read/increment/write a
 * cross-window transaction; localStorage alone provides no such guarantee.
 * The exported primitive remains synchronous for migrations and pure tests.
 * orders an open against a same-path removal tombstone, or against an
 * in-flight liveness probe, when wall-clock time cannot be trusted to differ.
 * `max(last + 1, now)` tracks real time while staying strictly increasing even
 * for two calls in the same millisecond; the CLEARED_KEY generation stamp uses
 * the same construction.
 */
export function nextRecentSeq(): number {
  let last = Math.max(readClearSeq(), readRemovalFloor());
  try {
    const stored = Number(localStorage.getItem(SEQ_KEY));
    if (isSequence(stored)) last = Math.max(last, stored);
  } catch {
    // storage unavailable
  }
  const now = Date.now();
  const clock = isSequence(now) ? now : 1;
  // `last` is bounded by isSequence/readRemovalFloor, so the successor is safe.
  const next = Math.max(last + 1, clock);
  try {
    localStorage.setItem(SEQ_KEY, String(next));
  } catch {
    // storage full / unavailable — best effort, as everywhere else in this file
  }
  return next;
}

interface Tombstone {
  readonly path: string;
  readonly seq: number;
}

// Same posture as parseRecent: a JSON-valid but wrong-shaped value reads as no
// tombstones. A row missing either field is dropped rather than defaulted —
// a tombstone with a fabricated seq removes entries it never referred to.
function parseTombstones(raw: string | null): Tombstone[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    const out: Tombstone[] = [];
    for (const item of parsed) {
      if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { path?: unknown }).path === 'string' &&
        typeof (item as { seq?: unknown }).seq === 'number' &&
        isSequence((item as { seq: number }).seq)
      ) {
        out.push({ path: (item as { path: string }).path, seq: (item as { seq: number }).seq });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readTombstones(): Tombstone[] {
  try {
    return parseTombstones(localStorage.getItem(REMOVED_KEY));
  } catch {
    return [];
  }
}

function readRemovalFloor(): number {
  try {
    const raw = Number(localStorage.getItem(REMOVED_BEFORE_KEY));
    return isSequence(raw) ? raw : 0;
  } catch {
    return 0;
  }
}

function writeRemovalFloor(value: number): void {
  if (!isSequence(value)) return;
  try {
    localStorage.setItem(REMOVED_BEFORE_KEY, String(value));
  } catch {
    // storage full / unavailable — best effort
  }
}

function writeTombstones(list: Tombstone[]): void {
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify(list));
  } catch {
    // storage full / unavailable — best effort
  }
}

/** Record a removal tombstone for each path, folding with whatever another
 * window already recorded (newest seq per path wins), capped to REMOVED_MAX
 * with the oldest evicted first. */
function addTombstones(paths: readonly string[], seq: number): void {
  if (paths.length === 0) return;
  const byPath = new Map<string, Tombstone>();
  for (const tombstone of readTombstones()) {
    const held = byPath.get(tombstone.path);
    if (!held || held.seq < tombstone.seq) byPath.set(tombstone.path, tombstone);
  }
  for (const p of paths) {
    const held = byPath.get(p);
    if (!held || held.seq < seq) byPath.set(p, { path: p, seq });
  }
  const ordered = [...byPath.values()].sort((a, b) => b.seq - a.seq);
  const kept = ordered.slice(0, REMOVED_MAX);
  const evicted = ordered.slice(REMOVED_MAX);
  if (evicted.length > 0) {
    // Floor first: interruption between the writes may conservatively refuse
    // a stale absent row, but can never resurrect a removed one.
    writeRemovalFloor(Math.max(readRemovalFloor(), ...evicted.map((t) => t.seq)));
  }
  writeTombstones(kept);
}

/** Entries a tombstone did not remove: everything (re)opened AFTER its path's
 * removal. An entry with no `seq` predates the field and can never be shown to
 * postdate a tombstone, so it goes — the same "cannot prove it is newer"
 * posture `survivingClear` takes for `openedAt`. */
export function survivingRemovals(
  entries: RecentEntry[],
  tombstones: readonly Tombstone[],
): RecentEntry[] {
  if (tombstones.length === 0) return entries;
  const removedAt = new Map<string, number>();
  for (const tombstone of tombstones) {
    const held = removedAt.get(tombstone.path);
    if (held === undefined || held < tombstone.seq) {
      removedAt.set(tombstone.path, tombstone.seq);
    }
  }
  return entries.filter((e) => {
    const at = removedAt.get(e.path);
    if (at === undefined) return true;
    return typeof e.seq === 'number' && e.seq > at;
  });
}

export function readRecent(): RecentEntry[] {
  return mergeRecent(
    survivingRemovals(
      survivingClear(readStored(), readClearSeq()),
      readTombstones(),
    ),
    [],
  );
}

/** Entries a clear at `clearSeq` did not remove: everything opened under a
 * later logical sequence. Wall-clock `openedAt` is display data only — it can
 * repeat or move backward. */
export function survivingClear(entries: RecentEntry[], clearSeq: number): RecentEntry[] {
  if (clearSeq <= 0) return entries;
  return entries.filter((e) => isSequence(e.seq) && e.seq > clearSeq);
}

/**
 * The Clear Recent primitive: empty the shared list for every window and stamp
 * the clear generation, so a window mirroring a stale pre-clear list back does
 * not resurrect it.
 *
 * Called only inside `clearRecentStorageSafely`, which the `file.clearRecent`
 * command owns — never inferred from an
 * empty list reaching `persistRecent`, because removing a window's last
 * LOCALLY-KNOWN entry produces the same empty list and must not wipe entries
 * only another window has written. Intent cannot be recovered from the shape of
 * an empty array after the fact; it is signalled by the caller that has it.
 */
export function clearRecentStorage(): void {
  const generation = nextRecentSeq();
  try {
    localStorage.setItem(CLEARED_KEY, String(generation));
    localStorage.setItem(KEY, '[]');
  } catch {
    // storage full / unavailable — the list is best-effort
  }
}

/**
 * Persist `next`, folding in whatever another window has added since this one
 * last wrote, and return what was actually stored.
 *
 * The key is shared by every window, and the list is hydrated once at boot and
 * mirrored back WHOLE — so a plain write erases every open the other window
 * recorded in between. The fold is PER ENTRY, not per path-presence: another
 * window re-opening a path this window already knows produces a newer record
 * for it, and treating only unknown paths as foreign overwrites that with this
 * window's stale timestamp and stale provenance.
 *
 * Removal cannot ride on the fold, because a merge that keeps the newest record
 * of every path can never drop one. Clear Recent therefore stamps a generation
 * (`CLEARED_KEY`) and per-path removal a tombstone (`REMOVED_KEY`); every
 * window folds against both.
 *
 * An empty `next` is an ordinary merge like any other, never a clear: it is
 * equally what removing this window's last locally-known entry produces, and
 * treating it as a clear deletes entries only another window ever knew about.
 */
export function persistRecent(next: RecentEntry[]): RecentEntry[] {
  const stored = survivingRemovals(
    survivingClear(readStored(), readClearSeq()),
    readTombstones(),
  );
  const clearSeq = readClearSeq();
  const floor = readRemovalFloor();
  const storedPaths = new Set(stored.map((entry) => entry.path));
  // A compacted tombstone no longer names its path. It instead proves that an
  // absent entry at/below the floor came from a stale window. A genuine reopen
  // receives a later seq and is admitted.
  const admissibleNext = survivingClear(next, clearSeq).filter(
    (entry) =>
      floor === 0 || storedPaths.has(entry.path) || (isSequence(entry.seq) && entry.seq > floor),
  );
  const merged = survivingRemovals(
    mergeRecent(
      admissibleNext,
      stored,
    ),
    readTombstones(),
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // storage full / unavailable — the list is best-effort
  }
  return merged;
}

// WebView2 exposes Web Locks for the app's trustworthy localhost origin. It is
// the cross-window serialization boundary: localStorage makes each get/set
// atomic, but not a read-modify-write transaction. The fallback keeps unit
// tests and storage-disabled environments ordered within one realm; the live
// e2e gate asserts the shipped webview has navigator.locks.
let fallbackLock: Promise<void> = Promise.resolve();

async function withRecentStorageLock<T>(operation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(STORAGE_LOCK, operation);
  }
  const result = fallbackLock.then(operation, operation);
  fallbackLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Record one successful open. The sequence allocation and the storage merge
 * share a lock, so two windows cannot allocate the same generation or erase
 * one another's entries between read and write. */
export function recordRecentOpen(
  current: RecentEntry[],
  path: string,
  openedAt: number,
  sourceUrl?: string,
): Promise<RecentEntry[]> {
  return withRecentStorageLock(() => {
    const base = persistRecent(current);
    return persistRecent(withRecent(base, path, openedAt, sourceUrl, nextRecentSeq()));
  });
}

interface ExpectedRecentEntry {
  readonly path: string;
  readonly openedAt: number | null;
  readonly seq?: number;
  readonly sourceUrl?: string;
}

function sameEntryGeneration(entry: RecentEntry, expected: ExpectedRecentEntry): boolean {
  return (
    entry.openedAt === expected.openedAt &&
    entry.seq === expected.seq &&
    entry.sourceUrl === expected.sourceUrl
  );
}

/** Remove paths under the shared lock. `expected` turns an async liveness
 * verdict into compare-and-remove: a path reopened (or given web provenance)
 * after the probe survives. */
export function removeRecentEntriesSafely(
  current: RecentEntry[],
  paths: readonly string[],
  expected: readonly ExpectedRecentEntry[] = [],
): Promise<{ removedPaths: string[]; next: RecentEntry[] }> {
  return withRecentStorageLock(() => {
    const base = persistRecent(current);
    const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
    const removable = paths.filter((path) => {
      const entry = base.find((candidate) => candidate.path === path);
      if (!entry) return false;
      const bound = expectedByPath.get(path);
      return !bound || sameEntryGeneration(entry, bound);
    });
    if (removable.length === 0) return { removedPaths: [], next: base };
    const next = removeRecentEntries(base, removable);
    return { removedPaths: removable, next: persistRecent(next) };
  });
}

/** Clear under the same serialization boundary as opens and removals. */
export function clearRecentStorageSafely(): Promise<RecentEntry[]> {
  return withRecentStorageLock(() => {
    clearRecentStorage();
    return [];
  });
}

/** The complete storage-event key set. */
export function isRecentStorageKey(key: string | null): boolean {
  return (
    key === null ||
    key === KEY ||
    key === CLEARED_KEY ||
    key === REMOVED_KEY
  );
}

/** Whether two lists carry the same entries in the same order — the guard on
 * adopting a merge result back into state. */
export function sameRecent(a: readonly RecentEntry[], b: readonly RecentEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) =>
        e.path === b[i].path &&
        e.openedAt === b[i].openedAt &&
        e.sourceUrl === b[i].sourceUrl &&
        e.seq === b[i].seq,
    )
  );
}

/** Move `path` to the front of `current` with a fresh timestamp, capped —
 * pure list computation. `seq` (from `nextRecentSeq`) is what lets this open
 * outrank a removal tombstone recorded in the same millisecond; omitting it
 * produces an entry with no stamp at all, which loses to every tombstone. */
export function withRecent(
  current: RecentEntry[],
  path: string,
  openedAt: number,
  sourceUrl?: string,
  seq?: number,
): RecentEntry[] {
  // A re-open that does not re-supply the address keeps the one already on
  // record: `path` is a temp copy of a web download, and dropping its
  // provenance would leave the recent row re-opening a purgeable temp path with
  // no way back to its source. An explicit address still overrides.
  const url = sourceUrl ?? current.find((e) => e.path === path)?.sourceUrl;
  return [
    { path, openedAt, ...(url ? { sourceUrl: url } : {}), ...(seq !== undefined ? { seq } : {}) },
    ...current.filter((e) => e.path !== path),
  ].slice(0, MAX);
}

/**
 * Fold two lists into one, newest open per path, most recent first. Sequence
 * is the authority when present; openedAt is display data and may move
 * backward with the system clock.
 *
 * Recents are app-wide by meaning and the key is shared by every window, so a
 * window that hydrated its list at boot and mirrors it back whole would erase
 * every open another window recorded since. An entry with no recorded time
 * sorts last and loses to any timed entry for the same path — it is an honest
 * "unknown", not a zero.
 */
export function mergeRecent(a: RecentEntry[], b: RecentEntry[]): RecentEntry[] {
  const best = new Map<string, RecentEntry>();
  for (const entry of [...a, ...b]) {
    const held = best.get(entry.path);
    if (!held) {
      best.set(entry.path, entry);
      continue;
    }
    const heldSeq = held.seq;
    const entrySeq = entry.seq;
    const winner =
      heldSeq !== undefined || entrySeq !== undefined
        ? entrySeq !== undefined && (heldSeq === undefined || entrySeq > heldSeq)
          ? entry
          : held
        : held.openedAt === null || (entry.openedAt !== null && entry.openedAt > held.openedAt)
          ? entry
          : held;
    const loser = winner === entry ? held : entry;
    // Provenance is never lost to a merge, for the same reason a re-open does
    // not drop it: `path` is a temp copy of a web download, and an entry with
    // no way back to its address re-opens a path that may be gone. The newer
    // record still overrides an older address when it carries one.
    const sourceUrl = winner.sourceUrl ?? loser.sourceUrl;
    best.set(
      entry.path,
      sourceUrl === winner.sourceUrl
        ? winner
        : {
            ...winner,
            ...(sourceUrl ? { sourceUrl } : {}),
          },
    );
  }
  return [...best.values()]
    .sort((x, y) => (y.seq ?? -1) - (x.seq ?? -1) || (y.openedAt ?? -1) - (x.openedAt ?? -1))
    .slice(0, MAX);
}

/**
 * Low-level removal used inside `removeRecentEntriesSafely`: remove `paths`
 * from `current`, recording a tombstone for each so neither a
 * stale mirror from another window nor a delayed async result can bring them
 * back. Pure with respect to its return value; the tombstone write is the one
 * necessary side effect, the same posture `persistRecent` takes. The caller
 * dispatches the returned list as the new recentFiles state like any other
 * change, and the tombstone rides along through every later merge. Product
 * callers never invoke this outside the shared lock.
 *
 * Removing the LAST entry this window knows of leaves an empty list, which is
 * NOT a clear: the tombstones name exactly what goes, and a path only another
 * window has recorded survives the merge untouched.
 */
export function removeRecentEntries(current: RecentEntry[], paths: readonly string[]): RecentEntry[] {
  if (paths.length === 0) return current;
  const seq = nextRecentSeq();
  addTombstones(paths, seq);
  const set = new Set(paths);
  return current.filter((e) => !set.has(e.path));
}

/** One path's liveness. `indeterminate` covers permission, network and
 * transient I/O failures — never treated as dead. */
export type RecentPathStatus = 'exists' | 'missing' | 'indeterminate';

/**
 * Probe every LOCAL (non-`sourceUrl`) recent entry and compute the removal of
 * exactly those positively confirmed dead — never a `sourceUrl` entry (its temp
 * copy being gone is not a dead path; the address is still useful), never one
 * merely `indeterminate`.
 *
 * State is read TWICE through the same accessor on purpose: once to know what
 * to probe, once immediately before computing the result, so a path re-opened
 * WHILE the probe was in flight is excluded — its `seq` has moved past what was
 * snapshotted at probe start, and an unchanged `seq` is the only thing that
 * authorizes removal. Returns null when there is nothing to remove, a
 * `classify` failure included: indeterminate-everything is exactly that.
 */
export async function sweepDeadRecents(
  getState: () => readonly RecentEntry[],
  classify: (paths: string[]) => Promise<RecentPathStatus[]>,
): Promise<{ removedPaths: string[]; next: RecentEntry[] } | null> {
  const atStart = getState();
  const candidates = atStart.filter((e) => !e.sourceUrl);
  if (candidates.length === 0) return null;
  const paths = candidates.map((e) => e.path);
  let statuses: RecentPathStatus[];
  try {
    statuses = await classify(paths);
  } catch {
    return null;
  }
  const dead = paths.filter((p, i) => statuses[i] === 'missing');
  if (dead.length === 0) return null;
  const current = getState();
  const result = await removeRecentEntriesSafely([...current], dead, candidates);
  return result.removedPaths.length === 0 ? null : result;
}

/** The opened-when column's label. Relative where it reads naturally
 * ("Today 14:32", "Yesterday"), a plain date beyond that, an em dash for
 * entries whose time was never recorded. */
export function formatOpenedAt(openedAt: number | null, now: number): string {
  if (openedAt === null) return '—';
  const then = new Date(openedAt);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const time = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
  if (sameDay(then, today)) return tChrome('chrome.recent.today', { time });
  // A CALENDAR step, not now-24h: a real-time subtraction overshoots across
  // a 23-hour DST spring-forward day and mislabels yesterday for an hour
  // (regression).
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(then, yesterday)) return tChrome('chrome.recent.yesterday', { time });
  // The date part follows the ACTIVE locale (Intl owns month names —
  // never a hand-rolled table). en output is byte-identical to the old
  // 'Mmm D' / 'Mmm D, YYYY' strings, which is what keeps the pure tests
  // meaningful as en pins.
  const sameYear = then.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(formattingLocale(), {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(then);
}
