// Recent-files list helpers (Phase 4 M2). parseRecent must never let a
// JSON-valid-but-wrong-shaped localStorage value through as a non-array —
// that would crash HomeTab's recentFiles.map on the first render.
import { describe, expect, it } from 'vitest';
import { parseRecent, withRecent } from '../src/renderer/lib/recent-files';

describe('parseRecent', () => {
  it('reads a valid string array', () => {
    expect(parseRecent('["a.pdf","b.pdf"]')).toEqual(['a.pdf', 'b.pdf']);
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
    expect(parseRecent('[1,"a.pdf",null,"b.pdf",{}]')).toEqual(['a.pdf', 'b.pdf']);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseRecent('{not json')).toEqual([]);
  });
});

describe('withRecent', () => {
  it('moves an existing path to the front (dedup)', () => {
    expect(withRecent(['a.pdf', 'b.pdf', 'c.pdf'], 'c.pdf')).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);
  });

  it('prepends a new path', () => {
    expect(withRecent(['a.pdf'], 'b.pdf')).toEqual(['b.pdf', 'a.pdf']);
  });

  it('caps the list at 10', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `f${i}.pdf`);
    const next = withRecent(ten, 'new.pdf');
    expect(next).toHaveLength(10);
    expect(next[0]).toBe('new.pdf');
    expect(next).not.toContain('f9.pdf'); // oldest dropped
  });
});
