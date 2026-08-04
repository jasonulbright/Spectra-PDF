// N11 slice D — the symbol registry: the part-list SANITIZER, the built-in
// artwork, the JSON interchange and its refusals, and the search.
//
// The sanitizer is the load-bearing one. A part list becomes PDF path
// OPERATORS, so anything it lets through is concatenated into a content
// stream — which is why the tests below push strings, NaN, Infinity and
// out-of-range coordinates at it rather than only well-formed shapes.
//
// localStorage stub per the app-settings precedent (vitest runs in node).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYMBOL_MAX_PARTS,
  SYMBOL_MAX_POINTS,
  partsFromJson,
  partsToJson,
  sanitizeParts,
  type SymbolPart,
} from '../src/renderer/lib/count-marks';
import {
  BUILTIN_SYMBOL_SETS,
  SYMBOL_SET_MAX_SYMBOLS,
  addSymbolSet,
  findSymbol,
  getSymbolSets,
  parseSymbolSetFile,
  reloadSymbolSets,
  removeSymbolSet,
  searchSymbols,
  symbolSetToJson,
  symbolParts,
  type SymbolDef,
  type SymbolSet,
} from '../src/renderer/lib/symbol-library';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  reloadSymbolSets();
});
afterEach(() => {
  vi.unstubAllGlobals();
  reloadSymbolSets();
});

const okPoly: SymbolPart = { kind: 'poly', points: [0, 0, 1, 1], closed: false };

function setFile(symbols: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'Firm standard', symbols, ...extra });
}

describe('sanitizeParts — untrusted artwork', () => {
  it('accepts a well-formed poly and circle, quantized', () => {
    const parts = sanitizeParts([
      { kind: 'poly', points: [0.123456, 0.2, 0.8, 0.9], closed: true },
      { kind: 'circle', cx: 0.5, cy: 0.5, r: 0.25 },
    ]);
    expect(parts).toEqual([
      { kind: 'poly', points: [0.1235, 0.2, 0.8, 0.9], closed: true },
      { kind: 'circle', cx: 0.5, cy: 0.5, r: 0.25 },
    ]);
  });

  it('refuses the whole list when ANY part is malformed', () => {
    // Partial artwork is a lie about what the file said.
    expect(sanitizeParts([okPoly, { kind: 'blob', d: 'M0 0 L1 1' }])).toBeNull();
  });

  it.each([
    ['not an array', {}],
    ['empty', []],
    ['a string coordinate', [{ kind: 'poly', points: ['0 0 1 1 re f'], closed: false }]],
    ['a mixed string coordinate', [{ kind: 'poly', points: [0, 0, '1 1 re', 1], closed: false }]],
    ['NaN', [{ kind: 'poly', points: [0, 0, Number.NaN, 1], closed: false }]],
    ['Infinity', [{ kind: 'poly', points: [0, 0, Number.POSITIVE_INFINITY, 1], closed: false }]],
    ['a negative coordinate', [{ kind: 'poly', points: [0, 0, -0.1, 1], closed: false }]],
    ['a coordinate past 1', [{ kind: 'poly', points: [0, 0, 1.2, 1], closed: false }]],
    ['an odd point count', [{ kind: 'poly', points: [0, 0, 1], closed: false }]],
    ['a single point', [{ kind: 'poly', points: [0, 0], closed: false }]],
    ['a circle with r = 0', [{ kind: 'circle', cx: 0.5, cy: 0.5, r: 0 }]],
    ['a circle leaving the unit square', [{ kind: 'circle', cx: 0.9, cy: 0.5, r: 0.3 }]],
    ['a null part', [null]],
  ])('refuses %s', (_label, raw) => {
    expect(sanitizeParts(raw)).toBeNull();
  });

  it('refuses past the part and point ceilings', () => {
    const many = Array.from({ length: SYMBOL_MAX_PARTS + 1 }, () => ({ ...okPoly }));
    expect(sanitizeParts(many)).toBeNull();
    const long = { kind: 'poly', points: Array.from({ length: SYMBOL_MAX_POINTS + 2 }, () => 0.5), closed: false };
    expect(sanitizeParts([long])).toBeNull();
  });

  it('round-trips through JSON, and rejects an injected one', () => {
    const parts = sanitizeParts([okPoly])!;
    expect(partsFromJson(partsToJson(parts))).toEqual(parts);
    expect(partsFromJson('not json')).toBeNull();
    expect(partsFromJson(undefined)).toBeNull();
    // The shape a smuggled operator string would arrive as.
    expect(partsFromJson('[{"kind":"poly","points":["0 0 m 1 1 l S"],"closed":false}]')).toBeNull();
  });
});

describe('the built-in sets', () => {
  it('are all valid artwork by their own sanitizer', () => {
    // Our own drawings go through the same gate an imported file does — a
    // symbol drawn outside the unit square would be clipped by the appearance
    // BBox and nobody would see it until it printed.
    for (const set of BUILTIN_SYMBOL_SETS) {
      for (const symbol of set.symbols) {
        expect(sanitizeParts(symbol.parts), `${set.id}/${symbol.id}`).not.toBeNull();
      }
    }
  });

  it('use ids unique across every set', () => {
    const seen = new Set<string>();
    for (const set of BUILTIN_SYMBOL_SETS) {
      for (const symbol of set.symbols) {
        expect(seen.has(symbol.id), symbol.id).toBe(false);
        seen.add(symbol.id);
      }
    }
  });

  it('carry a localized name for every set and symbol', () => {
    // A built-in name is OUR word and localizes like a built-in stamp's; a
    // missing key would ship an English label inside a Spanish palette.
    for (const set of BUILTIN_SYMBOL_SETS) {
      expect(PANEL_STRINGS).toHaveProperty(`panel.symbols.set.${set.id}`);
      for (const symbol of set.symbols) {
        expect(PANEL_STRINGS).toHaveProperty(`panel.symbols.name.${symbol.id}`);
      }
    }
  });

  it('resolve by id, and an unknown id resolves to nothing', () => {
    expect(symbolParts('aec-door')).not.toBeNull();
    expect(findSymbol('aec-door')?.set.id).toBe('aec');
    expect(symbolParts('no-such-symbol')).toBeNull();
    expect(findSymbol(undefined)).toBeNull();
  });
});

describe('parseSymbolSetFile', () => {
  const good = [{ id: 'fs-outlet', name: 'Outlet', parts: [okPoly] }];

  it('accepts a well-formed file and mints an id when it has none', () => {
    const res = parseSymbolSetFile(setFile(good));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.set.name).toBe('Firm standard');
    expect(res.set.id).toMatch(/^set-/);
    expect(res.set.symbols[0]).toEqual({ id: 'fs-outlet', name: 'Outlet', parts: [okPoly] });
  });

  it('keeps a declared id — that is what makes a re-import an UPDATE', () => {
    const res = parseSymbolSetFile(setFile(good, { id: 'firm' }));
    expect(res.ok && res.set.id).toBe('firm');
  });

  it('falls back to the id as the display name when a symbol has none', () => {
    const res = parseSymbolSetFile(setFile([{ id: 'fs-x', parts: [okPoly] }]));
    expect(res.ok && res.set.symbols[0].name).toBe('fs-x');
  });

  it.each([
    ['refusal.symbolSet.notJson', '{oops'],
    ['refusal.symbolSet.notASet', '[]'],
    ['refusal.symbolSet.notASet', '{"name":"x"}'],
    ['refusal.symbolSet.noSymbols', setFile([])],
    ['refusal.symbolSet.setId', setFile(good, { id: 'has space' })],
    ['refusal.symbolSet.builtinId', setFile(good, { id: 'aec' })],
    ['refusal.symbolSet.symbolShape', setFile(['nope'])],
    ['refusal.symbolSet.symbolId', setFile([{ id: 'has space', parts: [okPoly] }])],
    ['refusal.symbolSet.parts', setFile([{ id: 'fs-a', parts: [{ kind: 'poly', points: [2, 2, 3, 3] }] }])],
    ['refusal.symbolSet.parts', setFile([{ id: 'fs-a' }])],
    [
      'refusal.symbolSet.duplicateId',
      setFile([
        { id: 'fs-a', parts: [okPoly] },
        { id: 'fs-a', parts: [okPoly] },
      ]),
    ],
    ['refusal.symbolSet.idInUse', setFile([{ id: 'aec-door', parts: [okPoly] }])],
  ])('refuses with %s', (key, text) => {
    const res = parseSymbolSetFile(text);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal.key).toBe(key);
  });

  it('refuses a set past the symbol ceiling', () => {
    const many = Array.from({ length: SYMBOL_SET_MAX_SYMBOLS + 1 }, (_, i) => ({
      id: `fs-${i}`,
      parts: [okPoly],
    }));
    const res = parseSymbolSetFile(setFile(many));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal.key).toBe('refusal.symbolSet.tooManySymbols');
  });

  it('lets a set RE-import its own symbol ids (an update, not a collision)', () => {
    const first = parseSymbolSetFile(setFile(good, { id: 'firm' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    addSymbolSet(first.set);
    const again = parseSymbolSetFile(setFile(good, { id: 'firm' }));
    expect(again.ok).toBe(true);
    expect(addSymbolSet(first.set)).toBe('updated');
  });

  it('round-trips through the export shape', () => {
    const parsed = parseSymbolSetFile(setFile(good, { id: 'firm' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const again = parseSymbolSetFile(symbolSetToJson(parsed.set));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.set).toEqual(parsed.set);
  });
});

describe('the registry', () => {
  const imported: SymbolSet = {
    id: 'firm',
    name: 'Firm standard',
    symbols: [{ id: 'fs-outlet', name: 'Wall outlet', parts: [okPoly] }],
  };

  it('adds, resolves and removes an imported set', () => {
    expect(addSymbolSet(imported)).toBe('added');
    expect(getSymbolSets().some((s) => s.id === 'firm')).toBe(true);
    expect(symbolParts('fs-outlet')).toEqual([okPoly]);
    removeSymbolSet('firm');
    expect(symbolParts('fs-outlet')).toBeNull();
  });

  it('re-reads what was written to the store from outside', () => {
    store.set(
      'symbol-sets',
      JSON.stringify([{ id: 'firm', name: 'Firm', symbols: [{ id: 'fs-a', parts: [okPoly] }] }]),
    );
    reloadSymbolSets();
    expect(symbolParts('fs-a')).toEqual([okPoly]);
  });

  it('drops a stored set whose artwork does not survive the sanitizer', () => {
    store.set(
      'symbol-sets',
      JSON.stringify([
        {
          id: 'firm',
          name: 'Firm',
          symbols: [
            { id: 'fs-bad', parts: [{ kind: 'poly', points: [5, 5, 6, 6] }] },
            { id: 'fs-good', parts: [okPoly] },
          ],
        },
      ]),
    );
    reloadSymbolSets();
    expect(symbolParts('fs-bad')).toBeNull();
    expect(symbolParts('fs-good')).toEqual([okPoly]);
  });

  it('never lets a stored set shadow a built-in one', () => {
    store.set(
      'symbol-sets',
      JSON.stringify([{ id: 'aec', name: 'Fake', symbols: [{ id: 'x-1', parts: [okPoly] }] }]),
    );
    reloadSymbolSets();
    expect(getSymbolSets().filter((s) => s.id === 'aec')).toHaveLength(1);
    expect(getSymbolSets().find((s) => s.id === 'aec')?.builtin).toBe(true);
  });
});

describe('searchSymbols', () => {
  const shown = (_set: SymbolSet, symbol: SymbolDef): string => symbol.name;

  it('returns everything for an empty query', () => {
    const all = searchSymbols('', shown);
    const count = getSymbolSets().reduce((n, s) => n + s.symbols.length, 0);
    expect(all).toHaveLength(count);
  });

  it('matches the display name case-insensitively', () => {
    const hits = searchSymbols('DOOR', shown);
    expect(hits.map((h) => h.symbol.id)).toContain('aec-door');
    expect(hits.every((h) => /door/i.test(h.symbol.name) || /door/i.test(h.symbol.id))).toBe(true);
  });

  it('matches the id too — that is what a shared set file carries', () => {
    expect(searchSymbols('aec-north', shown).map((h) => h.symbol.id)).toEqual(['aec-north-arrow']);
  });

  it('matches the LOCALIZED name a user actually reads', () => {
    // The display resolver is the caller's, so a Spanish palette searches
    // Spanish — with the authored English still matching, because that is what
    // the file says.
    const spanish = (_s: SymbolSet, sym: SymbolDef): string =>
      sym.id === 'aec-door' ? 'Puerta abatible' : sym.name;
    expect(searchSymbols('puerta', spanish).map((h) => h.symbol.id)).toEqual(['aec-door']);
    expect(searchSymbols('door swing', spanish).map((h) => h.symbol.id)).toEqual(['aec-door']);
  });

  it('finds nothing for a query nothing matches', () => {
    expect(searchSymbols('zzzz-nothing', shown)).toHaveLength(0);
  });
});
