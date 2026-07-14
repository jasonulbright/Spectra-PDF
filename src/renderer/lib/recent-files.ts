// Recent-files list (the `spectra-recent` localStorage key). Lives in the ui
// slice so the File ▸ Open Recent menu and the Home tab render it reactively
// (Phase 4 M2); App mirrors ui.recentFiles → localStorage in one effect, so
// callers only compute the next list and dispatch. Both open paths (App's
// openByPaths and the panels' useActiveFile empty-state open) route through
// pushRecent so they can't desync.
import type { AppAction } from '../state/types';
import type { Dispatch } from 'react';

const KEY = 'spectra-recent';
const MAX = 10;

export function readRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Move `path` to the front of `current`, capped — pure list computation. */
export function withRecent(current: string[], path: string): string[] {
  return [path, ...current.filter((p) => p !== path)].slice(0, MAX);
}

/** Push a path onto the recent list in state (App's effect persists it). */
export function pushRecent(dispatch: Dispatch<AppAction>, current: string[], path: string): void {
  dispatch({ type: 'UI_SET_RECENT_FILES', files: withRecent(current, path) });
}
