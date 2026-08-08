import { describe, expect, it } from 'vitest';
import {
  EXPAND_MODES,
  PATTERN_IDS,
  SAME_MARK_TOLERANCE_PT,
  groupByPage,
  groupState,
  hitIsMarked,
  hitKey,
  markRequests,
  parsePageRange,
  parseWordList,
  requestIsEmpty,
  sameRegion,
  toggleGroup,
  toggleOne,
  type FileSearchResult,
  type SearchHit,
} from '../src/renderer/lib/search-redact';

// The Search & Redact panel's model. Everything here is pure,
// which is the point: there is no DOM test environment, so the rules that
// decide WHAT gets marked live in functions a test can call rather than
// inside a component nothing renders.

function hit(page: number, index: number, rects: [number, number, number, number][]): SearchHit {
  return {
    page,
    index,
    text: 'Smith',
    source: 'query',
    context: '…Smith…',
    rects: rects.map((rect, i) => ({
      run: i,
      rect,
      codes: [0, 4] as [number, number],
      partial: true,
      imprecise: false,
    })),
    runs: rects.map((_, i) => i),
  };
}

function file(path: string, hits: SearchHit[]): FileSearchResult {
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    hits,
    pagesWithoutText: [],
    truncated: false,
    error: null,
  };
}

describe('hit identity', () => {
  it('keys on path + page + the engine index, never on the rect', () => {
    // Two hits with the SAME rect (a pattern and a query naming the same
    // characters) must still be distinguishable; two floats are not an
    // identity.
    const a = hit(3, 0, [[10, 10, 20, 20]]);
    const b = hit(3, 1, [[10, 10, 20, 20]]);
    expect(hitKey('a.pdf', a)).not.toBe(hitKey('a.pdf', b));
    expect(hitKey('a.pdf', a)).not.toBe(hitKey('b.pdf', a));
  });
});

describe('selection model', () => {
  const keys = ['k1', 'k2', 'k3'];

  it('is tri-state over a group', () => {
    expect(groupState(keys, new Set())).toBe('none');
    expect(groupState(keys, new Set(['k1']))).toBe('some');
    expect(groupState(keys, new Set(keys))).toBe('all');
    expect(groupState([], new Set(['k1']))).toBe('none');
  });

  it('a half-ticked group fills, a full one clears', () => {
    expect([...toggleGroup(keys, new Set(['k1']))].sort()).toEqual(keys);
    expect([...toggleGroup(keys, new Set(keys))]).toEqual([]);
  });

  it('toggling a group leaves other selections alone', () => {
    const next = toggleGroup(['k1'], new Set(['k9']));
    expect(next.has('k9')).toBe(true);
    expect(next.has('k1')).toBe(true);
  });

  it('toggles one key without mutating the input set', () => {
    const before = new Set(['k1']);
    const after = toggleOne('k2', before);
    expect([...before]).toEqual(['k1']);
    expect([...after].sort()).toEqual(['k1', 'k2']);
    expect([...toggleOne('k1', after)]).toEqual(['k2']);
  });
});

describe('already-marked detection', () => {
  it('matches within half a point in every edge', () => {
    expect(sameRegion([10, 10, 20, 20], [10.4, 9.6, 20.4, 20.4])).toBe(true);
    expect(sameRegion([10, 10, 20, 20], [10.6, 10, 20, 20])).toBe(false);
    expect(SAME_MARK_TOLERANCE_PT).toBe(0.5);
  });

  it('normalizes corner order before comparing', () => {
    expect(sameRegion([20, 20, 10, 10], [10, 10, 20, 20])).toBe(true);
  });

  it('needs EVERY rect of a multi-run hit to be marked', () => {
    // A phrase broken over a line wrap has one rect per run. Reporting it as
    // "already marked" with only half of it covered would disable the box
    // that would have covered the other half — a redaction reporting success
    // over surviving content.
    const wrapped = hit(2, 0, [
      [10, 10, 20, 20],
      [100, 30, 140, 40],
    ]);
    expect(hitIsMarked(wrapped, [{ page: 2, rect: [10, 10, 20, 20] }])).toBe(false);
    expect(
      hitIsMarked(wrapped, [
        { page: 2, rect: [10, 10, 20, 20] },
        { page: 2, rect: [100, 30, 140, 40] },
      ]),
    ).toBe(true);
  });

  it('does not match a mark on another page', () => {
    const h = hit(2, 0, [[10, 10, 20, 20]]);
    expect(hitIsMarked(h, [{ page: 3, rect: [10, 10, 20, 20] }])).toBe(false);
  });

  it('a hit with no rects is never already marked', () => {
    const empty: SearchHit = { ...hit(1, 0, []), rects: [] };
    expect(hitIsMarked(empty, [{ page: 1, rect: [0, 0, 1, 1] }])).toBe(false);
  });
});

describe('word list', () => {
  it('drops blank lines — a trailing newline must not OR in "match everything"', () => {
    expect(parseWordList('Smith\n\n  Oak  \n')).toEqual(['Smith', 'Oak']);
    expect(parseWordList('   \n\n')).toEqual([]);
  });

  it('handles CRLF', () => {
    expect(parseWordList('a\r\nb')).toEqual(['a', 'b']);
  });
});

describe('page range', () => {
  it('accepts the shipped syntax', () => {
    expect(parsePageRange('all', 10)).toBeNull();
    expect(parsePageRange('', 10)).toBeNull();
    expect(parsePageRange('1,3,5-7', 10)).toEqual([1, 3, 5, 6, 7]);
    expect(parsePageRange('3,3,2', 10)).toEqual([2, 3]);
  });

  it('names the offending token', () => {
    expect(() => parsePageRange('1,x', 10)).toThrow('x');
    expect(() => parsePageRange('9-3', 10)).toThrow('9-3');
    expect(() => parsePageRange('11', 10)).toThrow('11');
    expect(() => parsePageRange('0', 10)).toThrow('0');
  });
});

describe('the request', () => {
  const base = {
    query: '',
    terms: [] as string[],
    patterns: [] as string[],
    options: {},
    expand: 'match' as const,
    pages: null,
    maxHits: 10,
  };

  it('is empty only when nothing at all was given', () => {
    expect(requestIsEmpty(base)).toBe(true);
    expect(requestIsEmpty({ ...base, query: '  ' })).toBe(true);
    expect(requestIsEmpty({ ...base, query: 'a' })).toBe(false);
    expect(requestIsEmpty({ ...base, terms: ['a'] })).toBe(false);
    expect(requestIsEmpty({ ...base, patterns: ['email'] })).toBe(false);
  });
});

describe('grouping and mark requests', () => {
  it('groups by page in page order, keeping the engine order within a page', () => {
    const hits = [hit(3, 0, [[0, 0, 1, 1]]), hit(1, 1, [[0, 0, 1, 1]]), hit(3, 2, [[0, 0, 1, 1]])];
    const groups = groupByPage(hits);
    expect(groups.map((g) => g.page)).toEqual([1, 3]);
    expect(groups[1].hits.map((h) => h.index)).toEqual([0, 2]);
  });

  it('emits one request per RECT, across documents', () => {
    const a = file('a.pdf', [hit(1, 0, [[0, 0, 1, 1], [5, 5, 6, 6]])]);
    const b = file('b.pdf', [hit(2, 0, [[9, 9, 10, 10]])]);
    const selected = new Set([hitKey('a.pdf', a.hits[0]), hitKey('b.pdf', b.hits[0])]);
    expect(markRequests([a, b], selected)).toEqual([
      { path: 'a.pdf', page: 1, rect: [0, 0, 1, 1] },
      { path: 'a.pdf', page: 1, rect: [5, 5, 6, 6] },
      { path: 'b.pdf', page: 2, rect: [9, 9, 10, 10] },
    ]);
  });

  it('emits nothing for an unchecked hit — the checkbox is what consents', () => {
    const a = file('a.pdf', [hit(1, 0, [[0, 0, 1, 1]])]);
    expect(markRequests([a], new Set())).toEqual([]);
  });
});

describe('the catalogues the panel offers', () => {
  it("mirrors the engine's pattern ids exactly", () => {
    // Pinned against engine/text_match.PATTERN_IDS (asserted there too): a
    // pattern added on one side and not the other is either an unreachable
    // capability or a checkbox that refuses.
    expect([...PATTERN_IDS]).toEqual([
      'phone',
      'email',
      'credit_card',
      'ssn',
      'date',
      'iban',
      'nhs_uk',
      'sin_ca',
      'url',
    ]);
  });

  it('offers exactly the three expand modes the engine accepts', () => {
    expect([...EXPAND_MODES]).toEqual(['match', 'word', 'line']);
  });
});
