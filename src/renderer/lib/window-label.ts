// This window's identity, and the localStorage keys derived from it.
//
// Every workspace window loads the same origin, so `localStorage` is ONE
// store shared by all of them. Keys divide into two classes and the split has
// to be made key by key:
//
//   • App-wide values (settings, dictionaries, presets, recents) stay on their
//     shared key. The read-through ones are safe as they are; the state-
//     mirrored ones re-read before writing so a stale window cannot clobber a
//     newer one's list.
//   • VIEW state — this window's pane widths, its snap and takeoff choices,
//     its toolbar — gets a per-window key, because a second window mirroring
//     its own layout back over a shared key silently resizes the first.
//
// The primary window keeps the unsuffixed key with exactly its old meaning,
// and any other window falls back to reading it when it has no value of its
// own — so an existing layout carries over and a newly opened window starts
// from the layout the user is looking at rather than from defaults.

import { getCurrentWindow } from '@tauri-apps/api/window';

/** The label the primary window is created under. */
export const PRIMARY_WINDOW_LABEL = 'main';

let cached: string | null = null;

/**
 * This window's label, read synchronously off the webview's own metadata —
 * boot hydration runs before any command can resolve. Outside a webview (the
 * node test environment) there is one realm, which is the primary one.
 */
export function windowLabel(): string {
  if (cached === null) {
    try {
      cached = getCurrentWindow().label || PRIMARY_WINDOW_LABEL;
    } catch {
      cached = PRIMARY_WINDOW_LABEL;
    }
  }
  return cached;
}

/** Whether this window is the one the app opened by itself. */
export function isPrimaryWindow(): boolean {
  return windowLabel() === PRIMARY_WINDOW_LABEL;
}

/** The per-window storage key for a base key. Pure, so it is testable. */
export function scopedKeyFor(base: string, label: string): string {
  return label === PRIMARY_WINDOW_LABEL ? base : `${base}:${label}`;
}

export function scopedKey(base: string): string {
  return scopedKeyFor(base, windowLabel());
}

/**
 * A per-window value, falling back to the primary window's so a new window
 * opens with the layout in front of the user rather than the defaults.
 */
export function readScoped(base: string): string | null {
  try {
    const own = localStorage.getItem(scopedKey(base));
    if (own !== null) return own;
    return isPrimaryWindow() ? null : localStorage.getItem(base);
  } catch {
    return null;
  }
}

export function writeScoped(base: string, value: string): void {
  try {
    localStorage.setItem(scopedKey(base), value);
  } catch {
    // storage full / unavailable — view state is best-effort
  }
}

export function removeScoped(base: string): void {
  try {
    localStorage.removeItem(scopedKey(base));
  } catch {
    // storage unavailable — the session keeps its in-memory value
  }
}
