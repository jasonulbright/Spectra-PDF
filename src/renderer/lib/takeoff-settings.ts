// The REMEMBERED count groups and which one is armed.
//
// A module store, not reducer state, for the `snap-settings` reason: the
// Takeoff dock panel, the secondary toolbar's group picker and the page cell
// all need the same answer to "which group does the next click count?", and
// they sit in three different trees. One module owns the value; three
// components subscribe with `useSyncExternalStore`. No React here (the
// `app-settings` leaf rule).
//
// What this store is NOT: the document's groups. Those are DERIVED from the
// marks in the file (`count-marks.ts`'s `derivedGroups`) and win on a name
// collision — this is the memory of groups you have used, so a fresh drawing
// starts with your own list instead of a blank one. Its own key (`takeoff-ui`)
// rather than a field inside `spectra-settings`, because that loader merges
// one level deep and would replace a nested object wholesale.
import {
  COUNT_SYMBOLS,
  DEFAULT_COUNT_SYMBOL,
  type CountGroup,
} from './count-marks';
import { readScoped, writeScoped } from './window-label';

// Per WINDOW: the armed group is what the next click in THIS window places,
// and the value is cached in a module store a second window would mirror back
// whole over the first one's.
const KEY = 'takeoff-ui';

export interface TakeoffSettings {
  /** Remembered groups, in the order the panel lists them. */
  groups: CountGroup[];
  /** The armed group's NAME (identity is the name), or null for none — a
   * count mode with nothing armed places nothing, which is honest: the panel
   * says so rather than inventing a group behind the user's back. */
  armed: string | null;
}

export const DEFAULT_TAKEOFF_SETTINGS: TakeoffSettings = { groups: [], armed: null };

const HEX = /^#[0-9a-f]{6}$/i;

function coerceGroup(raw: unknown): CountGroup | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return null;
  const color = typeof r.color === 'string' && HEX.test(r.color) ? r.color : '#e0393e';
  const symbol =
    typeof r.symbol === 'string' && COUNT_SYMBOLS.some((s) => s.id === r.symbol)
      ? r.symbol
      : DEFAULT_COUNT_SYMBOL;
  return { name, color, symbol };
}

export function readTakeoffSettings(
  defaults: TakeoffSettings = DEFAULT_TAKEOFF_SETTINGS,
): TakeoffSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readScoped(KEY) || '{}');
  } catch {
    return { groups: [...defaults.groups], armed: defaults.armed };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { groups: [...defaults.groups], armed: defaults.armed };
  }
  const r = raw as Record<string, unknown>;
  const groups: CountGroup[] = [];
  if (Array.isArray(r.groups)) {
    for (const entry of r.groups) {
      const g = coerceGroup(entry);
      // Names are identity, so a stored duplicate is dropped rather than
      // carried — two rows named the same would arm ambiguously.
      if (g && !groups.some((x) => x.name === g.name)) groups.push(g);
    }
  }
  const armed =
    typeof r.armed === 'string' && groups.some((g) => g.name === r.armed) ? r.armed : null;
  return { groups, armed };
}

export function writeTakeoffSettings(value: TakeoffSettings): void {
  writeScoped(KEY, JSON.stringify(value));
}

let current: TakeoffSettings | null = null;
const listeners = new Set<() => void>();

export function getTakeoffSettings(): TakeoffSettings {
  if (current === null) current = readTakeoffSettings();
  return current;
}

export function setTakeoffSettings(next: TakeoffSettings): void {
  current = next;
  writeTakeoffSettings(next);
  for (const fn of [...listeners]) fn();
}

/** Arm a group by name (null disarms). Remembers it too when it is not in the
 * list yet — arming a group the FILE carries is exactly how a group learned
 * from someone else's drawing enters your own list. */
export function armCountGroup(group: CountGroup | null): void {
  const s = getTakeoffSettings();
  if (!group) {
    setTakeoffSettings({ ...s, armed: null });
    return;
  }
  const groups = s.groups.some((g) => g.name === group.name) ? s.groups : [...s.groups, group];
  setTakeoffSettings({ groups, armed: group.name });
}

export function rememberGroup(group: CountGroup): void {
  const s = getTakeoffSettings();
  const groups = s.groups.some((g) => g.name === group.name)
    ? s.groups.map((g) => (g.name === group.name ? group : g))
    : [...s.groups, group];
  setTakeoffSettings({ ...s, groups });
}

export function forgetGroup(name: string): void {
  const s = getTakeoffSettings();
  setTakeoffSettings({
    groups: s.groups.filter((g) => g.name !== name),
    armed: s.armed === name ? null : s.armed,
  });
}

export function subscribeTakeoffSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
