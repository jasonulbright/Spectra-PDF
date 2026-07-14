// Recent-files list (the `spectra-recent` localStorage key). Lives in the ui
// slice so the File ▸ Open Recent menu and the Home tab render it reactively
// (Phase 4 M2); App mirrors ui.recentFiles → localStorage in one effect, so
// callers only compute the next list (withRecent) and dispatch. readRecent is
// the one validated reader — used by boot hydration.

const KEY = 'spectra-recent';
const MAX = 10;

// Pure, testable core: JSON-valid-but-wrong-shape (object, string, null) →
// [], never a non-array that would crash HomeTab's .map (review-caught).
export function parseRecent(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function readRecent(): string[] {
  return parseRecent(localStorage.getItem(KEY));
}

/** Move `path` to the front of `current`, capped — pure list computation. */
export function withRecent(current: string[], path: string): string[] {
  return [path, ...current.filter((p) => p !== path)].slice(0, MAX);
}
