// Custom stamp library (lib/stamp-library.ts): dynamic-token resolution,
// shape validation, and the localStorage round trip (stubbed — no DOM env).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasStampTokens,
  isCustomStamp,
  loadCustomStamps,
  resolveStampTokens,
  saveCustomStamps,
} from '../src/renderer/lib/stamp-library';

const NOW = new Date(2026, 6, 30, 14, 5, 0); // July 30 2026, 14:05 local

describe('stamp token resolution', () => {
  it('substitutes {date}, {time}, and {name} (case-insensitive)', () => {
    const out = resolveStampTokens('Reviewed by {name} on {DATE} at {Time}', NOW, 'Jason');
    expect(out).toBe(
      `Reviewed by Jason on ${NOW.toLocaleDateString()} at ${NOW.toLocaleTimeString()}`,
    );
  });

  it('collapses cleanly when the identity name is empty', () => {
    const out = resolveStampTokens('SIGNED {name} {date}', NOW, '');
    expect(out).toBe(`SIGNED ${NOW.toLocaleDateString()}`);
    expect(out).not.toMatch(/ {2}/);
  });

  it('leaves token-free labels untouched', () => {
    expect(resolveStampTokens('APPROVED', NOW, 'X')).toBe('APPROVED');
  });

  it('hasStampTokens recognizes the three tokens and nothing else', () => {
    expect(hasStampTokens('a {date}')).toBe(true);
    expect(hasStampTokens('a {TIME} b')).toBe(true);
    expect(hasStampTokens('{name}')).toBe(true);
    expect(hasStampTokens('{page}')).toBe(false);
    expect(hasStampTokens('plain')).toBe(false);
  });
});

describe('stamp shape validation', () => {
  it('accepts text and image stamps; rejects malformed entries', () => {
    expect(isCustomStamp({ id: 'a', label: 'HI', color: '#fff' })).toBe(true);
    expect(
      isCustomStamp({ id: 'b', label: 'Logo', color: '#fff', imageData: 'data:image/png;base64,AA==', aspect: 0.5 }),
    ).toBe(true);
    expect(isCustomStamp(null)).toBe(false);
    expect(isCustomStamp({ id: 'c', label: 'x' })).toBe(false); // no color
    expect(isCustomStamp({ id: 'd', label: 'x', color: '#fff', imageData: 'http://x' })).toBe(false);
    expect(
      isCustomStamp({ id: 'e', label: 'x', color: '#fff', imageData: 'data:image/png;base64,AA==', aspect: 0 }),
    ).toBe(false); // aspect must be > 0
  });
});

describe('library persistence (localStorage stub)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('round-trips a saved library', () => {
    const stamps = [
      { id: '1', label: 'SIGNED {date}', color: '#e0393e' },
      { id: '2', label: 'Logo', color: '#2f6fed', imageData: 'data:image/png;base64,AA==', aspect: 0.75 },
    ];
    saveCustomStamps(stamps);
    expect(loadCustomStamps()).toEqual(stamps);
  });

  it('returns [] for corrupt JSON or a non-array, and drops invalid entries', () => {
    store.set('custom-stamps', '{not json');
    expect(loadCustomStamps()).toEqual([]);
    store.set('custom-stamps', '{"a":1}');
    expect(loadCustomStamps()).toEqual([]);
    store.set(
      'custom-stamps',
      JSON.stringify([{ id: '1', label: 'OK', color: '#fff' }, { junk: true }, 7]),
    );
    expect(loadCustomStamps()).toEqual([{ id: '1', label: 'OK', color: '#fff' }]);
  });
});
