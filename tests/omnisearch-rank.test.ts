import { describe, it, expect } from 'vitest';
import {
  FRECENCY_HALF_LIFE_MS,
  FRECENCY_MAX_ENTRIES,
  frecencyWeight,
  parseFrecency,
  rankToolMatches,
  recordFrecencyPick,
  serializeFrecency,
  type FrecencyStore,
} from '../src/renderer/search/omnisearch-rank';
import { TOOL_DEFS } from '../src/renderer/commands/tools';

// The tool half of the omnisearch. There is no DOM test environment (the
// component itself drags in pdf.js and dies on DOMMatrix), so the ranking —
// the part that decides what a user sees first — lives in a pure leaf module
// and is pinned here.

describe('rankToolMatches', () => {
  it('is empty for an empty query (the box must not list all tools unprompted)', () => {
    expect(rankToolMatches('', TOOL_DEFS)).toEqual([]);
    expect(rankToolMatches('   ', TOOL_DEFS)).toEqual([]);
  });

  it('ranks a name PREFIX above a name substring above a description-only match', () => {
    const defs = [
      { id: 'a' as const, title: 'Alpha', description: 'nothing' },
      { id: 'b' as const, title: 'Beta Redact', description: 'nothing' },
      { id: 'c' as const, title: 'Gamma', description: 'redact things' },
      { id: 'd' as const, title: 'Redact', description: 'nothing' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const out = rankToolMatches('redact', defs).map((t) => t.title);
    expect(out).toEqual(['Redact', 'Beta Redact', 'Gamma']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    const lower = rankToolMatches('redact', TOOL_DEFS).map((t) => t.id);
    expect(rankToolMatches('  REDACT  ', TOOL_DEFS).map((t) => t.id)).toEqual(lower);
    expect(lower).toContain('redact');
  });

  it('finds a real tool by the START of its name', () => {
    // "org" is how a user reaches Organize Pages without typing the whole name.
    expect(rankToolMatches('org', TOOL_DEFS)[0]?.id).toBe('organize');
  });

  it('breaks ties alphabetically, so ordering is stable rather than catalog-order', () => {
    const defs = [
      { id: 'z' as const, title: 'Zebra', description: 'x' },
      { id: 'a' as const, title: 'Apple', description: 'x' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    expect(rankToolMatches('x', defs).map((t) => t.title)).toEqual(['Apple', 'Zebra']);
  });

  it('breaks ties by the COLLATION of the language it is handed', () => {
    // Swedish sorts ö after z; English sorts it among the o-vowels. A bare
    // localeCompare would follow the host locale instead of the UI language,
    // so the same list comes out in a different order on two machines.
    const defs = [
      { id: 'o' as const, title: 'Öppna', description: 'x' },
      { id: 'z' as const, title: 'Zoom', description: 'x' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    expect(rankToolMatches('x', defs, 'sv').map((t) => t.id)).toEqual(['z', 'o']);
    expect(rankToolMatches('x', defs, 'en').map((t) => t.id)).toEqual(['o', 'z']);
  });

  it('excludes tools that match nowhere', () => {
    expect(rankToolMatches('zzzzznotatool', TOOL_DEFS)).toEqual([]);
  });
});

// --- Frecency ------------------------------------------------------------

const NOW = 1_800_000_000_000;

// Two same-tier matches (both titles START with the query), so only the
// frecency signal can decide their order — the alphabetical tie-break would
// put Apple first every time.
const TIED = [
  { id: 'apple' as const, title: 'Xa Apple', description: 'x' },
  { id: 'zebra' as const, title: 'Xa Zebra', description: 'x' },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any;

describe('frecency', () => {
  it('decays by half over one half-life and is zero for an unknown tool', () => {
    const entry = { weight: 4, at: NOW };
    expect(frecencyWeight(entry, NOW)).toBe(4);
    expect(frecencyWeight(entry, NOW + FRECENCY_HALF_LIFE_MS)).toBeCloseTo(2, 10);
    expect(frecencyWeight(entry, NOW + 2 * FRECENCY_HALF_LIFE_MS)).toBeCloseTo(1, 10);
    expect(frecencyWeight(undefined, NOW)).toBe(0);
    // A clock that moved backwards must not AMPLIFY an entry.
    expect(frecencyWeight(entry, NOW - FRECENCY_HALF_LIFE_MS)).toBe(4);
  });

  it('adds one to the DECAYED weight, so recent use outweighs old volume', () => {
    // Four picks a half-life ago decay to 2; one pick today is worth 1. The
    // old tool still leads — that is the "frequent" half doing its job.
    const old: FrecencyStore = { a: { weight: 4, at: NOW } };
    const later = recordFrecencyPick(old, 'b', NOW + FRECENCY_HALF_LIFE_MS);
    expect(later.a!.weight).toBeCloseTo(2, 10);
    expect(later.b!.weight).toBe(1);
    // Two more half-lives with only b used flips it.
    let s = later;
    s = recordFrecencyPick(s, 'b', NOW + 2 * FRECENCY_HALF_LIFE_MS);
    s = recordFrecencyPick(s, 'b', NOW + 3 * FRECENCY_HALF_LIFE_MS);
    expect(frecencyWeight(s.b, NOW + 3 * FRECENCY_HALF_LIFE_MS)).toBeGreaterThan(
      frecencyWeight(s.a, NOW + 3 * FRECENCY_HALF_LIFE_MS),
    );
  });

  it('is bounded, dropping the weakest entries rather than growing forever', () => {
    let s: FrecencyStore = {};
    for (let i = 0; i < FRECENCY_MAX_ENTRIES + 12; i++) {
      s = recordFrecencyPick(s, `t${i}`, NOW + i);
      // The most recent tool is picked twice so it cannot be the one dropped.
      s = recordFrecencyPick(s, `t${i}`, NOW + i);
    }
    expect(Object.keys(s).length).toBeLessThanOrEqual(FRECENCY_MAX_ENTRIES);
    expect(s[`t${FRECENCY_MAX_ENTRIES + 11}`]).toBeDefined();
  });

  it('boosts WITHIN a tier and never lifts a non-match', () => {
    const store = recordFrecencyPick({}, 'zebra', NOW);
    expect(rankToolMatches('xa', TIED, '', store, NOW).map((t) => t.id)).toEqual([
      'zebra',
      'apple',
    ]);
    // Same store, a query neither picked tool matches: frecency adds nothing.
    expect(rankToolMatches('zzzzznotatool', TOOL_DEFS, '', store, NOW)).toEqual([]);
  });

  it('never jumps a tier: a heavily used description match stays below a name match', () => {
    const defs = [
      { id: 'name' as const, title: 'Redact', description: 'x' },
      { id: 'blurb' as const, title: 'Zebra', description: 'redact things' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    let store: FrecencyStore = {};
    for (let i = 0; i < 20; i++) store = recordFrecencyPick(store, 'blurb', NOW);
    expect(rankToolMatches('redact', defs, '', store, NOW).map((t) => t.id)).toEqual([
      'name',
      'blurb',
    ]);
  });

  it('falls back to the alphabetical tie-break when frecency is level', () => {
    const store = recordFrecencyPick(recordFrecencyPick({}, 'apple', NOW), 'zebra', NOW);
    expect(rankToolMatches('xa', TIED, 'en', store, NOW).map((t) => t.id)).toEqual([
      'apple',
      'zebra',
    ]);
  });

  it('round-trips through the persisted form', () => {
    const store = recordFrecencyPick(recordFrecencyPick({}, 'a', NOW), 'b', NOW + 5);
    expect(parseFrecency(serializeFrecency(store))).toEqual(store);
  });

  it('treats every corrupt persisted value as an empty store', () => {
    expect(parseFrecency(null)).toEqual({});
    expect(parseFrecency('')).toEqual({});
    expect(parseFrecency('{ not json')).toEqual({});
    expect(parseFrecency('[1,2,3]')).toEqual({});
    expect(parseFrecency('"a string"')).toEqual({});
    expect(parseFrecency('null')).toEqual({});
  });

  it('drops individual malformed entries but keeps the sound ones', () => {
    const raw = JSON.stringify({
      good: { weight: 2, at: NOW },
      noWeight: { at: NOW },
      badWeight: { weight: 'lots', at: NOW },
      negative: { weight: -3, at: NOW },
      infinite: { weight: Infinity, at: NOW },
      badAt: { weight: 1, at: 'yesterday' },
      notAnObject: 7,
      nulled: null,
    });
    expect(parseFrecency(raw)).toEqual({ good: { weight: 2, at: NOW } });
  });

  it('bounds what it will read back, so a bloated key cannot be loaded whole', () => {
    const raw: Record<string, { weight: number; at: number }> = {};
    for (let i = 0; i < FRECENCY_MAX_ENTRIES * 3; i++) raw[`t${i}`] = { weight: 1, at: NOW };
    expect(Object.keys(parseFrecency(JSON.stringify(raw))).length).toBe(FRECENCY_MAX_ENTRIES);
  });

  it('ranks identically to the baseline when no picks have been recorded', () => {
    const plain = rankToolMatches('re', TOOL_DEFS, 'en').map((t) => t.id);
    expect(rankToolMatches('re', TOOL_DEFS, 'en', {}, NOW).map((t) => t.id)).toEqual(plain);
  });
});
