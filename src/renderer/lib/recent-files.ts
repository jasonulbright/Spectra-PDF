// Recent-files list (the `spectra-recent` localStorage key). Lives in the ui
// slice so the File ▸ Open Recent menu and the Home tab render it reactively
// App mirrors ui.recentFiles → localStorage in one effect, so
// callers only compute the next list (withRecent) and dispatch. readRecent is
// the one validated reader — used by boot hydration.
//
// Entries carry WHEN they were opened (the Home tab's opened-when
// column). Legacy
// bare-string entries migrate with `openedAt: null` — an honest "unknown",
// displayed as an em dash, never a fabricated date.

import { formattingLocale, tChrome } from '../i18n';

const KEY = 'spectra-recent';
// Clear Recent empties the list for every window at once, and it has to
// survive a cross-window merge that otherwise keeps the newest record of every
// path. A generation stamp says WHEN the list was emptied, so a window still
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
const MAX = 10;
/** Cap on stored tombstones. Generous against the 10-entry visible cap (a user
 * removes more entries across sessions than are ever shown at once) but bounded,
 * or the key grows without limit. Lowest seq is evicted first; an evicted
 * tombstone can only be resurrected by a window that has been holding a stale
 * list across 32 other removals, none of them ever re-opened. */
const REMOVED_MAX = 32;

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
   * A monotonic counter stamp (never a wall-clock value — see `nextRecentSeq`),
   * set whenever this entry is (re)opened. It orders an open against a removal
   * tombstone for the same path when both could land in the same millisecond,
   * and detects a re-open that raced an in-flight async liveness probe. Absent
   * on an entry persisted before this field existed, or on one nothing has
   * (re)opened since; an absent stamp is older than every tombstone, which is
   * correct because a tombstone can only postdate the field.
   */
  seq?: number;
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
        typeof (item as { path?: unknown }).path === 'string'
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
          ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
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

function readClearedAt(): number {
  try {
    const raw = Number(localStorage.getItem(CLEARED_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

/**
 * Allocate a fresh, strictly increasing stamp shared by every window — what
 * orders an open against a same-path removal tombstone, or against an
 * in-flight liveness probe, when wall-clock time cannot be trusted to differ.
 * `max(last + 1, now)` tracks real time while staying strictly increasing even
 * for two calls in the same millisecond; the CLEARED_KEY generation stamp uses
 * the same construction.
 */
export function nextRecentSeq(): number {
  let last = 0;
  try {
    last = Number(localStorage.getItem(SEQ_KEY)) || 0;
  } catch {
    // storage unavailable
  }
  const next = Math.max(last + 1, Date.now());
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
        Number.isFinite((item as { seq: number }).seq)
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
  const stored = readTombstones();
  const byPath = new Map(stored.map((t) => [t.path, t]));
  for (const p of paths) {
    const held = byPath.get(p);
    if (!held || held.seq < seq) byPath.set(p, { path: p, seq });
  }
  const merged = [...byPath.values()].sort((a, b) => b.seq - a.seq).slice(0, REMOVED_MAX);
  writeTombstones(merged);
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
  const removedAt = new Map(tombstones.map((t) => [t.path, t.seq]));
  return entries.filter((e) => {
    const at = removedAt.get(e.path);
    if (at === undefined) return true;
    return typeof e.seq === 'number' && e.seq > at;
  });
}

export function readRecent(): RecentEntry[] {
  return survivingRemovals(
    survivingClear(readStored(), readClearedAt()),
    readTombstones(),
  );
}

/** Entries a clear at `clearedAt` did not remove: everything opened after it.
 * An entry with no recorded time cannot be shown to postdate the clear, and a
 * clear removes what it cannot distinguish rather than keeping it. */
export function survivingClear(entries: RecentEntry[], clearedAt: number): RecentEntry[] {
  if (clearedAt <= 0) return entries;
  return entries.filter((e) => e.openedAt !== null && e.openedAt > clearedAt);
}

/**
 * The Clear Recent primitive: empty the shared list for every window and stamp
 * the clear generation, so a window mirroring a stale pre-clear list back does
 * not resurrect it.
 *
 * Called ONLY from the `file.clearRecent` command — never inferred from an
 * empty list reaching `persistRecent`, because removing a window's last
 * LOCALLY-KNOWN entry produces the same empty list and must not wipe entries
 * only another window has written. Intent cannot be recovered from the shape of
 * an empty array after the fact; it is signalled by the caller that has it.
 */
export function clearRecentStorage(): void {
  // Strictly monotonic, so two windows clearing in the same millisecond still
  // produce distinct generations.
  const generation = Math.max(readClearedAt() + 1, Date.now());
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
  const stored = readStored();
  const clearedAt = readClearedAt();
  const merged = survivingRemovals(
    mergeRecent(
      survivingClear(next, clearedAt),
      survivingClear(stored, clearedAt),
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

/** Whether two lists carry the same entries in the same order — the guard on
 * adopting a merge result back into state. */
export function sameRecent(a: readonly RecentEntry[], b: readonly RecentEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) =>
        e.path === b[i].path &&
        e.openedAt === b[i].openedAt &&
        e.sourceUrl === b[i].sourceUrl,
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
 * Fold two lists into one, newest open per path, most recent first.
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
    const heldAt = held.openedAt;
    const at = entry.openedAt;
    const winner = heldAt === null || (at !== null && at > heldAt) ? entry : held;
    const loser = winner === entry ? held : entry;
    // Provenance is never lost to a merge, for the same reason a re-open does
    // not drop it: `path` is a temp copy of a web download, and an entry with
    // no way back to its address re-opens a path that may be gone. The newer
    // record still overrides an older address when it carries one.
    const sourceUrl = winner.sourceUrl ?? loser.sourceUrl;
    // The HIGHER stamp travels regardless of which record won on time: it is
    // what orders this path's open against its removal tombstone, so a merge
    // that dropped it would let a stale tombstone outrank a newer open. -1 is
    // the absent sentinel for the comparison only; it is never written out.
    const seq = Math.max(winner.seq ?? -1, loser.seq ?? -1);
    best.set(
      entry.path,
      sourceUrl === winner.sourceUrl && seq === (winner.seq ?? -1)
        ? winner
        : {
            ...winner,
            ...(sourceUrl ? { sourceUrl } : {}),
            ...(seq >= 0 ? { seq } : {}),
          },
    );
  }
  return [...best.values()]
    .sort((x, y) => (y.openedAt ?? -1) - (x.openedAt ?? -1))
    .slice(0, MAX);
}

/**
 * Remove `paths` from `current`, recording a tombstone for each so neither a
 * stale mirror from another window nor a delayed async result can bring them
 * back. Pure with respect to its return value; the tombstone write is the one
 * necessary side effect, the same posture `persistRecent` takes. The caller
 * dispatches the returned list as the new recentFiles state like any other
 * change, and the tombstone rides along through every later merge.
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
  const seqAtStart = new Map(candidates.map((e) => [e.path, e.seq ?? -1]));
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
  const stillDead = dead.filter((p) => {
    const entry = current.find((e) => e.path === p);
    if (!entry) return false;
    return (entry.seq ?? -1) === seqAtStart.get(p);
  });
  if (stillDead.length === 0) return null;
  return { removedPaths: stillDead, next: removeRecentEntries([...current], stillDead) };
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
