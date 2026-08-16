// The standards-conversion alteration report — the vocabulary mirror and the
// evidence lines.
//
// `engine/standards_report.py` is the authority on what a conversion reports.
// The renderer keeps a mirror of that vocabulary because the mirror is what
// derives the catalog keys, and a kind the engine emits with no mirror row
// would render as its own identifier. Both vocabularies are read out of the
// engine's own source text and pinned in both directions: the LOSS kinds every
// `_row` names, and the FACT names an undetermined row carries instead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import {
  ALTERATION_KINDS,
  FACT_KINDS,
  PAGE_MARKS,
  STRUCTURE_PARTS,
  countIsMeaningful,
  detailLine,
  detailLines,
  rowLabel,
  type AlterationRow,
} from '../src/renderer/lib/standards-report';

const ENGINE = readFileSync(resolve(__dirname, '../src/engine/standards_report.py'), 'utf8');
const KEYS: Record<string, string> = PANEL_STRINGS;

const row = (over: Partial<AlterationRow> = {}): AlterationRow => ({
  kind: 'pages_removed',
  count: 1,
  detail: [],
  ...over,
});

/** The bare strings of a Python tuple-of-strings literal. */
function stringsOf(name: string): string[] {
  const at = ENGINE.indexOf(`\n${name} = (`);
  expect(at, `${name} is not in the engine`).toBeGreaterThan(-1);
  const body = ENGINE.slice(at, ENGINE.indexOf('\n)', at));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe('the engine vocabulary the panels name', () => {
  it('every loss kind the engine builds has a mirror row', () => {
    const literal = [...ENGINE.matchAll(/_row\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    // `classify` builds the producer-named rows through `_row(kind, …)`, so
    // their kinds are only in the notice table.
    const table = ENGINE.slice(
      ENGINE.indexOf('\n_NOTICE_KINDS = ('),
      ENGINE.indexOf('\n)', ENGINE.indexOf('\n_NOTICE_KINDS = (')),
    );
    const named = [...table.matchAll(/,\s*"([a-z_]+)"\),/g)].map((m) => m[1]);
    const live = [...new Set([...literal, ...named])].sort();
    expect(live.length, 'the sweep stopped seeing the engine').toBeGreaterThan(10);
    expect([...ALTERATION_KINDS].sort()).toEqual(live);
  });

  it('every fact an undetermined row can name has a mirror row', () => {
    expect([...FACT_KINDS]).toEqual(stringsOf('FACT_NAMES'));
  });

  it('every structure part and page mark the engine names is mirrored', () => {
    const parts = [...ENGINE.matchAll(/"part":\s*"([a-z ]+)"/g)].map((m) => m[1]);
    expect([...STRUCTURE_PARTS].sort()).toEqual([...new Set(parts)].sort());
    const marks = [...ENGINE.matchAll(/marks\.add\("([a-z]+)"\)/g)].map((m) => m[1]);
    expect([...PAGE_MARKS].sort()).toEqual([...new Set(marks)].sort());
  });

  it('every mirrored name has a catalog entry', () => {
    for (const kind of [...ALTERATION_KINDS, ...FACT_KINDS]) {
      expect(KEYS[`panel.standards.row.${kind}`], `no label for ${kind}`).toBeTruthy();
    }
    for (const part of STRUCTURE_PARTS) {
      const key = `panel.standards.part.${part.replace(/ /g, '_')}`;
      expect(KEYS[key], `no label for ${part}`).toBeTruthy();
    }
    for (const mark of PAGE_MARKS) {
      expect(KEYS[`panel.standards.mark.${mark}`], `no label for ${mark}`).toBeTruthy();
    }
  });

  it('an unmirrored kind renders its own name rather than nothing', () => {
    expect(rowLabel('a_kind_the_engine_gained')).toBe('a_kind_the_engine_gained');
    expect(rowLabel('form_fields_removed')).toBe(KEYS['panel.standards.row.form_fields_removed']);
  });
});

describe('what a row shows', () => {
  it('a document-wide flag shows no number, a measured loss does', () => {
    expect(countIsMeaningful(row({ kind: 'encryption_removed', count: 1, detail: [] }))).toBe(
      false,
    );
    expect(
      countIsMeaningful(
        row({ kind: 'form_fields_removed', count: 1, detail: [{ before: 6, after: 0 }] }),
      ),
    ).toBe(true);
    expect(countIsMeaningful(row({ kind: 'images_removed', count: 4, detail: [] }))).toBe(true);
  });

  it('producer text is carried verbatim, not translated', () => {
    const line = detailLine({ message: 'reverting to normal PDF output' });
    expect(line).toEqual({ text: 'reverting to normal PDF output', verbatim: true });
  });

  it('a before/after pair and a substitution read as one change each', () => {
    expect(detailLine({ before: 6, after: 0 }).text).toContain('6');
    expect(detailLine({ before: 6, after: 0 }).text).toContain('0');
    const sub = detailLine({ requested: 'Helvetica', used: 'NimbusSans-Regular' }).text;
    expect(sub).toContain('Helvetica');
    expect(sub).toContain('NimbusSans-Regular');
  });

  it('a structure part reads as its label, and its old value rides along', () => {
    expect(detailLine({ part: 'structure tree' }).text).toBe(
      KEYS['panel.standards.part.structure_tree'],
    );
    const lang = detailLine({ part: 'document language', was: 'en-US' }).text;
    expect(lang).toContain(KEYS['panel.standards.part.document_language']);
    expect(lang).toContain('en-US');
  });

  it('a rasterized page names the page and what it used to paint', () => {
    const text = detailLine({ page: 3, was: ['text', 'vector'] }).text;
    expect(text).toContain('3');
    expect(text).toContain(KEYS['panel.standards.mark.text']);
    expect(text).toContain(KEYS['panel.standards.mark.vector']);
  });

  it('an unrecognized entry shape still shows its values', () => {
    expect(detailLine({ something: 'unexpected' }).text).toBe('unexpected');
  });

  it('an annotation census names the subtype and how many went', () => {
    const text = detailLine({ subtype: 'Widget', removed: 6 }).text;
    expect(text).toContain('Widget');
    expect(text).toContain('6');
  });

  it('every entry of a row becomes exactly one line', () => {
    const r = row({ detail: [{ name: 'data.xml' }, { name: 'notes.txt' }] });
    expect(detailLines(r).map((l) => l.text)).toEqual(['data.xml', 'notes.txt']);
  });
});
