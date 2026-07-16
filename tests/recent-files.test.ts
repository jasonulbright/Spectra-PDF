// Recent-files list helpers (Phase 4 M2). parseRecent must never let a
// JSON-valid-but-wrong-shaped localStorage value through as a non-array —
// that would crash HomeTab's recentFiles.map on the first render.
import { describe, expect, it } from 'vitest';
import { formatOpenedAt, parseRecent, withRecent } from '../src/renderer/lib/recent-files';

describe('parseRecent', () => {
  it('reads a valid string array', () => {
    // Legacy pre-M7 entries are bare strings; they migrate with an honest
    // "unknown" openedAt, never a fabricated date.
    expect(parseRecent('["a.pdf","b.pdf"]')).toEqual([
      { path: 'a.pdf', openedAt: null },
      { path: 'b.pdf', openedAt: null },
    ]);
  });

  it('treats null / empty as an empty list', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('')).toEqual([]);
    expect(parseRecent('[]')).toEqual([]);
  });

  it('rejects JSON-valid non-arrays (object, string, bool, number)', () => {
    expect(parseRecent('{}')).toEqual([]);
    expect(parseRecent('"true"')).toEqual([]);
    expect(parseRecent('true')).toEqual([]);
    expect(parseRecent('42')).toEqual([]);
    expect(parseRecent('null')).toEqual([]);
  });

  it('drops non-string members of an array', () => {
    expect(parseRecent('[1,"a.pdf",null,"b.pdf",{}]')).toEqual([
      { path: 'a.pdf', openedAt: null },
      { path: 'b.pdf', openedAt: null },
    ]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseRecent('{not json')).toEqual([]);
  });
});

describe('withRecent', () => {
  it('moves an existing path to the front (dedup) with a fresh timestamp', () => {
    expect(
      withRecent(
        [
          { path: 'a.pdf', openedAt: 1 },
          { path: 'b.pdf', openedAt: 2 },
          { path: 'c.pdf', openedAt: 3 },
        ],
        'c.pdf',
        99,
      ),
    ).toEqual([
      { path: 'c.pdf', openedAt: 99 },
      { path: 'a.pdf', openedAt: 1 },
      { path: 'b.pdf', openedAt: 2 },
    ]);
  });

  it('prepends a new path', () => {
    expect(withRecent([{ path: 'a.pdf', openedAt: 1 }], 'b.pdf', 2)).toEqual([
      { path: 'b.pdf', openedAt: 2 },
      { path: 'a.pdf', openedAt: 1 },
    ]);
  });

  it('caps the list at 10', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.pdf`, openedAt: i }));
    const next = withRecent(ten, 'new.pdf', 11);
    expect(next).toHaveLength(10);
    expect(next[0]).toEqual({ path: 'new.pdf', openedAt: 11 });
    expect(next.map((e) => e.path)).not.toContain('f9.pdf'); // oldest dropped
  });
});

describe('formatOpenedAt (the Home opened-when column, M7)', () => {
  // Fixed "now": 2026-07-16 15:00 local.
  const now = new Date(2026, 6, 16, 15, 0).getTime();

  it('renders today and yesterday with times, older dates plainly', () => {
    expect(formatOpenedAt(new Date(2026, 6, 16, 14, 32).getTime(), now)).toBe('Today 14:32');
    expect(formatOpenedAt(new Date(2026, 6, 16, 9, 5).getTime(), now)).toBe('Today 09:05');
    expect(formatOpenedAt(new Date(2026, 6, 15, 23, 59).getTime(), now)).toBe('Yesterday 23:59');
    expect(formatOpenedAt(new Date(2026, 6, 12, 8, 0).getTime(), now)).toBe('Jul 12');
    expect(formatOpenedAt(new Date(2025, 11, 3, 8, 0).getTime(), now)).toBe('Dec 3, 2025');
  });

  it('a pre-M7 entry with no recorded time reads as an em dash — never a fabricated date', () => {
    expect(formatOpenedAt(null, now)).toBe('—');
  });
});
