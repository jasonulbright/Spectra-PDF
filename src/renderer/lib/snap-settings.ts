// N11 slice A — persisted SNAP preferences.
//
// A snap preference is how you WORK, not a property of a file, so it lives in
// app settings and not in the document (the brief's § 2.5 rule). It gets its
// own `snap-ui` key rather than a field inside `spectra-settings` because the
// settings loader merges one level deep — a stored partial `snap` object
// would REPLACE the defaults wholesale and silently drop a type added later.
// Field-by-field coercion against the defaults (the workbench-ui precedent)
// is what makes a corrupt or older entry a no-op instead of a bad shape
// propagating into state.
import {
  ALL_SNAP_TYPES_ON,
  DEFAULT_SNAP_RADIUS_PX,
  SNAP_PRIORITY,
  type SnapType,
  type SnapTypeFlags,
} from './snap';

const KEY = 'snap-ui';

/** Radius bounds, in CSS pixels. Below ~2 px nothing is reachable; above
 * ~40 px the cursor stops meaning a position at all. */
export const SNAP_RADIUS_MIN = 2;
export const SNAP_RADIUS_MAX = 40;

export interface SnapSettings {
  /** The master toggle (status bar + View ▸ Snapping). */
  enabled: boolean;
  radiusPx: number;
  types: SnapTypeFlags;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  radiusPx: DEFAULT_SNAP_RADIUS_PX,
  types: ALL_SNAP_TYPES_ON,
};

function coerceTypes(raw: unknown, fallback: SnapTypeFlags): SnapTypeFlags {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const out: Record<SnapType, boolean> = { ...fallback };
  // Iterate the CODE's type list, never the stored object's keys: a type
  // added after this entry was written must take its default, and a stale key
  // must not survive as a phantom flag.
  for (const t of SNAP_PRIORITY) {
    if (typeof r[t] === 'boolean') out[t] = r[t] as boolean;
  }
  return out;
}

export function readSnapSettings(
  defaults: SnapSettings = DEFAULT_SNAP_SETTINGS,
): SnapSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  const radius =
    typeof r.radiusPx === 'number' && Number.isFinite(r.radiusPx)
      ? Math.min(SNAP_RADIUS_MAX, Math.max(SNAP_RADIUS_MIN, Math.round(r.radiusPx)))
      : defaults.radiusPx;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : defaults.enabled,
    radiusPx: radius,
    types: coerceTypes(r.types, defaults.types),
  };
}

export function writeSnapSettings(value: SnapSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // storage full / unavailable — a preference is best-effort
  }
}

// ── The live store ───────────────────────────────────────────────────────
// A tiny observable rather than reducer state, for one reason: `View ▸
// Snapping` is a registered COMMAND, and a command's `run` has `dispatch` and
// `state` — not the canvas view's local state. Routing the toggle through the
// reducer would put a persisted PREFERENCE into workspace state (which is
// about documents), and routing it through an `app` service would put a
// second owner beside the status bar's. One module owns the value; the menu
// command, the status bar and the canvas all read the same one.
//
// No React here (the `app-settings` leaf rule); the canvas subscribes with
// `useSyncExternalStore`.
let current: SnapSettings | null = null;
const listeners = new Set<() => void>();

export function getSnapSettings(): SnapSettings {
  if (current === null) current = readSnapSettings();
  return current;
}

export function setSnapSettings(next: SnapSettings): void {
  current = next;
  writeSnapSettings(next);
  for (const fn of [...listeners]) fn();
}

export function toggleSnapping(): void {
  const s = getSnapSettings();
  setSnapSettings({ ...s, enabled: !s.enabled });
}

export function subscribeSnapSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
