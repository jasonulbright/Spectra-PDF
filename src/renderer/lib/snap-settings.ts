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
  DEFAULT_SNAP_ANGLE_DEG,
  DEFAULT_SNAP_RADIUS_PX,
  SNAP_ANGLE_MAX,
  SNAP_ANGLE_MIN,
  SNAP_PRIORITY,
  type SnapType,
  type SnapTypeFlags,
} from './snap';
import { MEASURE_UNITS, type MeasureUnit } from './measure';
import { DEFAULT_GRID, GRID_SPACING_MAX, GRID_SPACING_MIN, type GridConfig } from './rulers';

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
  // ── slice B ──────────────────────────────────────────────────────────
  /** Shift's angle increment, in degrees. */
  angleDeg: number;
  /** Draw the grid. It is a SNAP source whenever `types.grid` is on and a
   * grid exists — the two are deliberately separate, because "snap to the
   * grid without a screen full of lines" is a real way to work and the king
   * separates them the same way (Show Grid vs Snap to Grid). */
  showGrid: boolean;
  grid: GridConfig;
  /** Show the rulers along the canvas edges. Guides are dragged off them, so
   * hiding the rulers does NOT hide the guides — they are separate toggles
   * for the same reason the king's are. */
  showRulers: boolean;
  showGuides: boolean;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  radiusPx: DEFAULT_SNAP_RADIUS_PX,
  // Every type on EXCEPT the grid, and that exception has a reason rather
  // than a preference behind it: the six geometric types only fire where
  // there is something to snap to, while a grid candidate exists at every
  // point on the page — so leaving it on by default would mean every gesture
  // in the product snapped somewhere, always. The king ships Snap to Grid off
  // for the same reason (its Show Grid is a separate switch, and so is ours).
  types: { ...ALL_SNAP_TYPES_ON, grid: false },
  angleDeg: DEFAULT_SNAP_ANGLE_DEG,
  showGrid: false,
  grid: DEFAULT_GRID,
  showRulers: false,
  showGuides: true,
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

function clampNumber(raw: unknown, lo: number, hi: number, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(hi, Math.max(lo, raw))
    : fallback;
}

function coerceGrid(raw: unknown, fallback: GridConfig): GridConfig {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const unit =
    typeof r.unit === 'string' && (MEASURE_UNITS as readonly string[]).includes(r.unit)
      ? (r.unit as MeasureUnit)
      : fallback.unit;
  return {
    spacing: clampNumber(r.spacing, GRID_SPACING_MIN, GRID_SPACING_MAX, fallback.spacing),
    unit,
    useScale: typeof r.useScale === 'boolean' ? r.useScale : fallback.useScale,
    // An origin may legitimately be negative (a grid phased off the page
    // corner), so it is bounded by the spacing range rather than clamped
    // positive.
    originX: clampNumber(r.originX, -GRID_SPACING_MAX, GRID_SPACING_MAX, fallback.originX),
    originY: clampNumber(r.originY, -GRID_SPACING_MAX, GRID_SPACING_MAX, fallback.originY),
  };
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
    angleDeg: Math.round(
      clampNumber(r.angleDeg, SNAP_ANGLE_MIN, SNAP_ANGLE_MAX, defaults.angleDeg),
    ),
    showGrid: typeof r.showGrid === 'boolean' ? r.showGrid : defaults.showGrid,
    grid: coerceGrid(r.grid, defaults.grid),
    showRulers: typeof r.showRulers === 'boolean' ? r.showRulers : defaults.showRulers,
    showGuides: typeof r.showGuides === 'boolean' ? r.showGuides : defaults.showGuides,
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

// The slice-B View-menu mirrors. Same argument as `toggleSnapping`: a
// registered command's `run` gets state + dispatch, not the canvas view, and
// these are persisted PREFERENCES rather than workspace state.
export function toggleRulers(): void {
  const s = getSnapSettings();
  setSnapSettings({ ...s, showRulers: !s.showRulers });
}

export function toggleGrid(): void {
  const s = getSnapSettings();
  setSnapSettings({ ...s, showGrid: !s.showGrid });
}

export function toggleGuides(): void {
  const s = getSnapSettings();
  setSnapSettings({ ...s, showGuides: !s.showGuides });
}

export function subscribeSnapSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
