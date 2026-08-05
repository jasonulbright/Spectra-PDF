import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_CODE_SETS,
  CODE_SET_MAX_CODES,
  FOIA_SET,
  PRIVACY_ACT_SET,
  addCodeSet,
  codeSetToJson,
  findCode,
  getCodeSets,
  loadUserCodeSets,
  parseCodeSetFile,
  removeCodeSet,
  saveUserCodeSets,
  type RedactionCodeSet,
} from '../src/renderer/lib/redaction-codes';
import {
  DEFAULT_REDACTION_PROPERTIES,
  hexToRgb,
  propertiesFromPayload,
  propertiesPayload,
  rgbToHex,
} from '../src/renderer/lib/redaction-properties';

// F15 slice E — the code catalogue and the property record. Both are pure
// (localStorage aside), which is what lets the rules that decide what gets
// DRAWN in a black box be tested at all.

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
});

const userSet: RedactionCodeSet = {
  id: 'firm',
  name: 'Firm codes',
  codes: [{ id: 'priv', label: 'PRIV', description: 'Attorney-client privilege' }],
};

describe('the built-in code sets', () => {
  it('ships the FOIA and Privacy Act sets, with citations as labels', () => {
    expect(BUILTIN_CODE_SETS.map((s) => s.id)).toEqual(['foia', 'privacy-act']);
    // The LABEL is what gets drawn in the box, so it is the citation itself.
    expect(FOIA_SET.codes.map((c) => c.label)).toContain('(b)(6)');
    expect(PRIVACY_ACT_SET.codes.map((c) => c.label)).toContain('(k)(2)');
  });

  it('gives every code an id, a label and a description', () => {
    for (const set of BUILTIN_CODE_SETS) {
      for (const code of set.codes) {
        expect(code.id).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(code.label.length).toBeGreaterThan(0);
        expect(code.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate code ids within a set', () => {
    for (const set of BUILTIN_CODE_SETS) {
      expect(new Set(set.codes.map((c) => c.id)).size).toBe(set.codes.length);
    }
  });
});

describe('user code sets', () => {
  it('persists, lists after the built-ins, and removes', () => {
    expect(addCodeSet(userSet)).toBe('added');
    expect(loadUserCodeSets()).toHaveLength(1);
    expect(getCodeSets().map((s) => s.id)).toEqual(['foia', 'privacy-act', 'firm']);
    expect(addCodeSet({ ...userSet, name: 'Renamed' })).toBe('updated');
    expect(loadUserCodeSets()[0].name).toBe('Renamed');
    removeCodeSet('firm');
    expect(loadUserCodeSets()).toEqual([]);
  });

  it('refuses to let a stored set shadow a built-in id', () => {
    // The picker resolves by id: a user set called `foia` would silently
    // replace the citation list a release is checked against.
    saveUserCodeSets([{ ...FOIA_SET, name: 'Not really FOIA' }]);
    expect(loadUserCodeSets()).toEqual([]);
    expect(getCodeSets().find((s) => s.id === 'foia')?.name).toBe(FOIA_SET.name);
  });

  it('survives a corrupt store rather than throwing', () => {
    store.set('spectra-redaction-code-sets', '{not json');
    expect(loadUserCodeSets()).toEqual([]);
  });
});

describe('the import file', () => {
  it('round-trips through the exported JSON', () => {
    const parsed = parseCodeSetFile(codeSetToJson(userSet));
    expect(parsed.refusal).toBeNull();
    expect(parsed.set).toEqual(userSet);
  });

  it('names each refusal rather than repairing the file', () => {
    // A half-understood code set would draw a label nobody chose into a box
    // that cannot be undone once applied.
    expect(parseCodeSetFile('{nope').refusal).toBe('notJson');
    expect(parseCodeSetFile('{"id":"x"}').refusal).toBe('notASet');
    expect(parseCodeSetFile('{"id":"x","name":"X","codes":[]}').refusal).toBe('notASet');
    expect(
      parseCodeSetFile('{"id":"x","name":"X","codes":[{"id":"a"}]}').refusal,
    ).toBe('notASet');
    expect(
      parseCodeSetFile(
        '{"id":"x","name":"X","codes":[{"id":"a","label":"A"},{"id":"a","label":"B"}]}',
      ).refusal,
    ).toBe('notASet');
    expect(parseCodeSetFile(codeSetToJson(FOIA_SET)).refusal).toBe('builtinId');
  });

  it('caps a set at the documented size', () => {
    const codes = Array.from({ length: CODE_SET_MAX_CODES + 1 }, (_, i) => ({
      id: `c${i}`,
      label: `L${i}`,
      description: '',
    }));
    expect(parseCodeSetFile(JSON.stringify({ id: 'big', name: 'Big', codes })).refusal).toBe(
      'notASet',
    );
  });
});

describe('finding a code', () => {
  it('resolves set/code, and only set/code', () => {
    expect(findCode('foia/b6')?.label).toBe('(b)(6)');
    expect(findCode('b6')).toBeNull();
    expect(findCode('foia/nope')).toBeNull();
    expect(findCode(undefined)).toBeNull();
  });
});

describe('the property payload', () => {
  it('omits what the user left at its default', () => {
    // "No overlay" and "an overlay of nothing" must stay distinguishable
    // through the file, or a round trip turns one into the other.
    expect(propertiesPayload(DEFAULT_REDACTION_PROPERTIES)).toEqual({});
  });

  it('sends only the overlay keys that mean something', () => {
    expect(
      propertiesPayload({
        ...DEFAULT_REDACTION_PROPERTIES,
        fill: [1, 1, 1],
        overlayText: '(b)(6)',
      }),
    ).toEqual({ fill: [1, 1, 1], overlay_text: '(b)(6)' });
    expect(
      propertiesPayload({
        ...DEFAULT_REDACTION_PROPERTIES,
        overlayText: 'X',
        repeatOverlay: true,
        align: 2,
        fontSize: 9,
        textColor: [1, 0, 0],
      }),
    ).toEqual({
      overlay_text: 'X',
      repeat_overlay: true,
      align: 2,
      font_size: 9,
      text_color: [1, 0, 0],
    });
  });

  it('never sends overlay settings without an overlay', () => {
    const payload = propertiesPayload({
      ...DEFAULT_REDACTION_PROPERTIES,
      repeatOverlay: true,
      align: 2,
      fontSize: 12,
    });
    expect(payload).toEqual({});
  });

  it('reads a listed mark back without inventing what the file did not state', () => {
    expect(propertiesFromPayload(undefined)).toEqual(DEFAULT_REDACTION_PROPERTIES);
    expect(propertiesFromPayload({ fill: [0, 0, 0] })).toEqual(DEFAULT_REDACTION_PROPERTIES);
    expect(
      propertiesFromPayload({
        fill: [0.2, 0.4, 0.6],
        overlay_text: '(b)(6)',
        repeat_overlay: true,
        align: 2,
        font_size: 9,
        text_color: [1, 1, 0],
      }),
    ).toEqual({
      fill: [0.2, 0.4, 0.6],
      overlayText: '(b)(6)',
      codeRef: '',
      repeatOverlay: true,
      align: 2,
      fontSize: 9,
      textColor: [1, 1, 0],
    });
  });

  it('round-trips a payload through the record', () => {
    const props = {
      ...DEFAULT_REDACTION_PROPERTIES,
      fill: [0.1, 0.2, 0.3] as [number, number, number],
      overlayText: 'CODE',
      align: 1 as const,
      fontSize: 8,
      textColor: [0, 1, 0] as [number, number, number],
    };
    expect(propertiesFromPayload(propertiesPayload(props))).toEqual({
      ...props,
      codeRef: '',
    });
  });
});

describe('colour conversion', () => {
  it('round-trips hex and rgb', () => {
    expect(rgbToHex([0, 0, 0])).toBe('#000000');
    expect(rgbToHex([1, 1, 1])).toBe('#ffffff');
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb('00ff00')).toEqual([0, 1, 0]);
    expect(hexToRgb('nope')).toBeNull();
  });
});
