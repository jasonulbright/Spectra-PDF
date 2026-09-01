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
// Clear Recent is the only removal, and it has to survive a cross-window
// merge that otherwise keeps the newest record of every path. A generation
// stamp says WHEN the list was emptied, so a window still holding the pre-clear
// list mirrors nothing back and a file opened after the clear still counts.
// Its own key: the list stays a plain array, so a build that predates this
// reads it unchanged.
const CLEARED_KEY = 'spectra-recent-cleared';
const MAX = 10;

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
        out.push({
          path: (item as { path: string }).path,
          openedAt: typeof at === 'number' && Number.isFinite(at) ? at : null,
          // A stored address that is not a string is dropped rather than
          // coerced: it drives a pre-filled request, so a wrong shape must
          // read as "no provenance", never as an address.
          ...(typeof from === 'string' && from !== '' ? { sourceUrl: from } : {}),
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

/** What this window last put on the key — the only thing that distinguishes an
 * empty list this window CLEARED from an empty list it never had. */
let lastWritten: RecentEntry[] | null = null;

export function readRecent(): RecentEntry[] {
  const list = survivingClear(readStored(), readClearedAt());
  lastWritten = list;
  return list;
}

/** Entries a clear at `clearedAt` did not remove: everything opened after it.
 * An entry with no recorded time cannot be shown to postdate the clear, and a
 * clear removes what it cannot distinguish rather than keeping it. */
export function survivingClear(entries: RecentEntry[], clearedAt: number): RecentEntry[] {
  if (clearedAt <= 0) return entries;
  return entries.filter((e) => e.openedAt !== null && e.openedAt > clearedAt);
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
 * (`CLEARED_KEY`) and every window folds against it.
 */
export function persistRecent(next: RecentEntry[]): RecentEntry[] {
  const stored = readStored();
  const clearedAt = readClearedAt();
  if (next.length === 0 && (lastWritten?.length ?? 0) > 0) {
    // Clear Recent. The stamp is strictly monotonic so two windows clearing in
    // the same millisecond still produce distinct generations.
    const generation = Math.max(clearedAt + 1, Date.now());
    try {
      localStorage.setItem(CLEARED_KEY, String(generation));
      localStorage.setItem(KEY, '[]');
    } catch {
      // storage full / unavailable — the list is best-effort
    }
    lastWritten = [];
    return [];
  }
  const merged = mergeRecent(
    survivingClear(next, clearedAt),
    survivingClear(stored, clearedAt),
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // storage full / unavailable — the list is best-effort
  }
  lastWritten = merged;
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
 * pure list computation. */
export function withRecent(
  current: RecentEntry[],
  path: string,
  openedAt: number,
  sourceUrl?: string,
): RecentEntry[] {
  // A re-open that does not re-supply the address keeps the one already on
  // record: `path` is a temp copy of a web download, and dropping its
  // provenance would leave the recent row re-opening a purgeable temp path with
  // no way back to its source. An explicit address still overrides.
  const url = sourceUrl ?? current.find((e) => e.path === path)?.sourceUrl;
  return [
    { path, openedAt, ...(url ? { sourceUrl: url } : {}) },
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
    best.set(entry.path, sourceUrl === winner.sourceUrl ? winner : { ...winner, sourceUrl });
  }
  return [...best.values()]
    .sort((x, y) => (y.openedAt ?? -1) - (x.openedAt ?? -1))
    .slice(0, MAX);
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
