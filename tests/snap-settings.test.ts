// N11 — the persisted snap/drafting preferences. The point of the module is
// that a stored entry written by an OLDER build (or a corrupt one) can only
// ever be a no-op: every field is coerced against the defaults, one by one,
// iterating the CODE's field list rather than the stored object's keys.
// Uses a localStorage stub since vitest runs in node (the app-settings
// precedent).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SNAP_SETTINGS,
  readSnapSettings,
  SNAP_RADIUS_MAX,
  SNAP_RADIUS_MIN,
  writeSnapSettings,
} from '../src/renderer/lib/snap-settings';
import { SNAP_ANGLE_MAX, SNAP_ANGLE_MIN, SNAP_PRIORITY } from '../src/renderer/lib/snap';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const stored = (value: unknown): void => {
  store.set('snap-ui', JSON.stringify(value));
};

describe('snap settings', () => {
  it('round-trips', () => {
    const next = {
      ...DEFAULT_SNAP_SETTINGS,
      enabled: false,
      radiusPx: 14,
      angleDeg: 30,
      showGrid: true,
      showRulers: true,
      grid: { spacing: 0.5, unit: 'ft' as const, useScale: true, originX: 1, originY: -2 },
    };
    writeSnapSettings(next);
    expect(readSnapSettings()).toEqual(next);
  });

  it('carries ALL SEVEN types from birth, so slice B migrated nothing', () => {
    for (const t of SNAP_PRIORITY) expect(t in DEFAULT_SNAP_SETTINGS.types).toBe(true);
  });

  it('starts every type on EXCEPT the grid, which fires everywhere', () => {
    // A geometric candidate exists only where there is geometry; a grid
    // candidate exists at every point on the page, so a default-on grid would
    // make every gesture in the product snap somewhere, always.
    for (const t of SNAP_PRIORITY) {
      expect(DEFAULT_SNAP_SETTINGS.types[t]).toBe(t !== 'grid');
    }
  });

  it('gives an entry written before a field existed that field default', () => {
    // Exactly what a slice-A install looks like to a slice-B build.
    stored({ enabled: false, radiusPx: 12, types: { endpoint: false } });
    const got = readSnapSettings();
    expect(got.enabled).toBe(false);
    expect(got.radiusPx).toBe(12);
    expect(got.types.endpoint).toBe(false);
    expect(got.types.midpoint).toBe(true); // untouched key keeps its default
    expect(got.angleDeg).toBe(DEFAULT_SNAP_SETTINGS.angleDeg);
    expect(got.grid).toEqual(DEFAULT_SNAP_SETTINGS.grid);
    expect(got.showRulers).toBe(DEFAULT_SNAP_SETTINGS.showRulers);
    expect(got.showGuides).toBe(DEFAULT_SNAP_SETTINGS.showGuides);
  });

  it('clamps the radius and the angle into their usable ranges', () => {
    stored({ radiusPx: 9999, angleDeg: 400 });
    expect(readSnapSettings().radiusPx).toBe(SNAP_RADIUS_MAX);
    expect(readSnapSettings().angleDeg).toBe(SNAP_ANGLE_MAX);
    stored({ radiusPx: -5, angleDeg: 0 });
    expect(readSnapSettings().radiusPx).toBe(SNAP_RADIUS_MIN);
    expect(readSnapSettings().angleDeg).toBe(SNAP_ANGLE_MIN);
  });

  it('rejects a grid spacing or unit it cannot use', () => {
    stored({ grid: { spacing: 0, unit: 'furlong', useScale: 'yes' } });
    const got = readSnapSettings().grid;
    expect(got.spacing).toBeGreaterThan(0);
    expect(got.unit).toBe(DEFAULT_SNAP_SETTINGS.grid.unit);
    expect(got.useScale).toBe(DEFAULT_SNAP_SETTINGS.grid.useScale);
  });

  it('keeps a NEGATIVE grid origin — a grid may be phased off the corner', () => {
    stored({ grid: { originX: -0.75 } });
    expect(readSnapSettings().grid.originX).toBeCloseTo(-0.75, 12);
  });

  it('falls back whole rather than half-reading a corrupt entry', () => {
    store.set('snap-ui', '{not json');
    expect(readSnapSettings()).toEqual(DEFAULT_SNAP_SETTINGS);
    stored(42);
    expect(readSnapSettings()).toEqual(DEFAULT_SNAP_SETTINGS);
    stored({ types: 'all', grid: 7 });
    expect(readSnapSettings().types).toEqual(DEFAULT_SNAP_SETTINGS.types);
    expect(readSnapSettings().grid).toEqual(DEFAULT_SNAP_SETTINGS.grid);
  });
});
