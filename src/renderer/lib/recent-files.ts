// Recent-files list (the `spectra-recent` localStorage key). Lives in the ui
// slice so the File ▸ Open Recent menu and the Home tab render it reactively
// (Phase 4 M2); App mirrors ui.recentFiles → localStorage in one effect, so
// callers only compute the next list (withRecent) and dispatch. readRecent is
// the one validated reader — used by boot hydration.
//
// M7: entries carry WHEN they were opened (the Home tab's opened-when
// column, an M2 deviation held on the deferral tracker until now). Legacy
// bare-string entries migrate with `openedAt: null` — an honest "unknown",
// displayed as an em dash, never a fabricated date.

const KEY = 'spectra-recent';
const MAX = 10;

export interface RecentEntry {
  path: string;
  /** Epoch ms of the last open; null for entries persisted before M7. */
  openedAt: number | null;
}

// Pure, testable core: JSON-valid-but-wrong-shape (object, string, null) →
// [], never a non-array that would crash HomeTab's .map (review-caught).
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
        out.push({
          path: (item as { path: string }).path,
          openedAt: typeof at === 'number' && Number.isFinite(at) ? at : null,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readRecent(): RecentEntry[] {
  return parseRecent(localStorage.getItem(KEY));
}

/** Move `path` to the front of `current` with a fresh timestamp, capped —
 * pure list computation. */
export function withRecent(
  current: RecentEntry[],
  path: string,
  openedAt: number,
): RecentEntry[] {
  return [
    { path, openedAt },
    ...current.filter((e) => e.path !== path),
  ].slice(0, MAX);
}

/** The opened-when column's label. Relative where it reads naturally
 * ("Today 14:32", "Yesterday"), a plain date beyond that, an em dash for
 * pre-M7 entries whose time was never recorded. */
export function formatOpenedAt(openedAt: number | null, now: number): string {
  if (openedAt === null) return '—';
  const then = new Date(openedAt);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const time = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
  if (sameDay(then, today)) return `Today ${time}`;
  // A CALENDAR step, not now-24h: a real-time subtraction overshoots across
  // a 23-hour DST spring-forward day and mislabels yesterday for an hour
  // (review-caught).
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(then, yesterday)) return `Yesterday ${time}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const datePart = `${months[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === today.getFullYear()
    ? datePart
    : `${datePart}, ${then.getFullYear()}`;
}
