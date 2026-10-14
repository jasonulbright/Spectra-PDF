// A text box in a bundled face on a signed document: the page-tier build
// adds font objects and a default resource entry, and the engine appends
// them as one revision where the certification allows it. The build takes no
// default resource entry away from a signed document, and elsewhere releases
// only the entry of a text box it draws again.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit } from './support/commit-cycle';
import { adding, buildPki, commitAndAppend, formDocument, retyping, sign, textBox } from './support/signed-text-box';
import type { Pki } from './support/signed-text-box';
import type { PageRef } from '../src/renderer/state/types';
import { HAS_BUNDLED_FACES } from './support/text-engine';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const N = PDFName.of;
const RUN = 120_000;
const FIRST = 'Zażółć gęślą';
const SECOND = 'Příliš žluťoučký kůň';

interface Reading {
  direct: boolean;
  /** /DR /Font: name to /BaseFont. */
  fonts: Record<string, string>;
  /** The /DA of each free text. */
  appearances: string[];
}

async function reading(bytes: Uint8Array): Promise<Reading> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.catalog.lookup(N('AcroForm'), PDFDict);
  const held = form.lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict);
  const annots = doc.getPage(0).node.lookup(N('Annots'), PDFArray);
  const appearances: string[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const dict = annots.lookup(i, PDFDict);
    const da = dict.lookup(N('DA'));
    if (String(dict.lookup(N('Subtype'))) === '/FreeText' && (da instanceof PDFString || da instanceof PDFHexString)) appearances.push(da.decodeText());
  }
  return {
    direct: doc.catalog.get(N('AcroForm')) instanceof PDFDict,
    fonts: Object.fromEntries(held.entries().map(([key, value]) => [key.decodeText(), String(doc.context.lookup(value, PDFDict).lookup(N('BaseFont')))])),
    appearances,
  };
}

/** How many font programs the objects of the file hold. */
async function fontPrograms(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.context.enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => object.has(N(key)))).length;
}

/** How many font programs and composite fonts the objects of the file hold. */
async function fontObjects(bytes: Uint8Array): Promise<{ programs: number; composite: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const dicts = doc.context.enumerateIndirectObjects().map(([, object]) => object).filter((object): object is PDFDict => object instanceof PDFDict);
  return {
    programs: dicts.filter((dict) => ['FontFile', 'FontFile2', 'FontFile3'].some((key) => dict.has(N(key)))).length,
    composite: dicts.filter((dict) => dict.get(N('Subtype')) === N('Type0')).length,
  };
}

/** Makes the first free text of the first page taller: the build draws its text again. */
const growing = (pages: PageRef[]): PageRef[] =>
  pages.map((page, index) => (index === 0 ? {
    ...page,
    annotations: (page.annotations ?? []).map((a) => (a.kind === 'freetext' ? { ...a, h: a.h * 1.2, geometryDiverged: true } : a)),
  } : page));

/** `bytes` with the form dictionary written in the catalog. */
async function withDirectForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.catalog.set(N('AcroForm'), doc.catalog.lookup(N('AcroForm'), PDFDict));
  return doc.save({ useObjectStreams: false });
}

describe.skipIf(!HAS_BUNDLED_FACES)('a text box in a bundled face on a signed document', () => {
  let dir: string;
  let pki: Pki;
  beforeAll(() => {
    dir = mkdtempSync(resolve('text-box-signed.local.d-'));
    pki = buildPki(resolve(dir, 'pki'));
  }, RUN);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const SUBSET = /^\/[A-Z]{6}\+LiberationSans$/;

  it('is appended as one revision under an approval signature, with and without a field lock, for either form', async () => {
    for (const [name, direct, options] of [
      ['approval.pdf', false, {}], ['approval-locked.pdf', false, { lock: 'all' }],
      ['approval-direct.pdf', true, { lock: 'include', lock_fields: ['name'] }],
    ] as const) {
      const signed = sign(await formDocument(direct), dir, name, pki, options);
      const result = await commitAndAppend(signed, dir, name, pki, adding(textBox(FIRST)));
      expect(result.report, name).toMatchObject({ applied: true, delta_classes: ['form-fill', 'annotations'] });
      const appended = new Uint8Array(readFileSync(result.output));
      expect(Buffer.from(appended.subarray(0, result.original.length)).equals(Buffer.from(result.original)), name).toBe(true);
      expect(result.signatures, name).toHaveLength(1);
      expect(result.signatures![0], name).toMatchObject({ intact: true, valid: true, trusted: true, modification_level: 'ANNOTATIONS', policy_ok: true });
      const read = await reading(appended);
      expect(read.direct, name).toBe(direct);
      expect(Object.keys(read.fonts).sort(), name).toEqual(['Helv', 'LiberationSans']);
      expect(read.fonts.LiberationSans, name).toMatch(SUBSET);
      expect(read.appearances, name).toHaveLength(1);
      expect(read.appearances[0], name).toContain('/LiberationSans 12 Tf');
    }
  }, 4 * RUN);

  it('is refused as a result under a certification that forbids annotations, and appended under one that allows them', async () => {
    const outcomes: Record<string, unknown> = {};
    for (const [level, direct] of [['none', false], ['form-fill', false], ['form-fill', true], ['annotate', false], ['annotate', true]] as const) {
      const name = `certified-${level}${direct ? '-direct' : ''}.pdf`;
      const signed = sign(await formDocument(direct), dir, name, pki, { certify: true, certify_level: level, lock: 'all' });
      const result = await commitAndAppend(signed, dir, name, pki, adding(textBox(FIRST)));
      outcomes[name] = result.report.applied
        ? { applied: true, ...Object.fromEntries(Object.entries(result.signatures![0]).filter(([key]) => ['intact', 'valid', 'policy_ok', 'modification_level'].includes(key))) }
        : { applied: false, reason: result.report.reason };
      expect(result.report.raised, name).toBeUndefined();
    }
    const kept = { applied: true, intact: true, valid: true, policy_ok: true, modification_level: 'ANNOTATIONS' };
    expect(outcomes).toEqual({
      'certified-none.pdf': { applied: false, reason: 'certified-none-forbids-form-fill' },
      'certified-form-fill.pdf': { applied: false, reason: 'certified-form-fill-forbids-annotations' },
      'certified-form-fill-direct.pdf': { applied: false, reason: 'certified-form-fill-forbids-annotations' },
      'certified-annotate.pdf': kept,
      'certified-annotate-direct.pdf': kept,
    });
  }, 6 * RUN);

  it('keeps every default resource entry when its text box is drawn again: the revision adds a font and takes none away', async () => {
    for (const direct of [false, true]) {
      const name = `retyped${direct ? '-direct' : ''}.pdf`;
      const committed = await commit(await formDocument(direct), adding(textBox(FIRST)));
      const base = direct ? await withDirectForm(committed) : committed;
      const before = await reading(base);
      expect(before.direct, name).toBe(direct);
      expect(Object.keys(before.fonts).sort(), name).toEqual(['Helv', 'LiberationSans']);
      const signed = sign(base, dir, name, pki, { certify: true, certify_level: 'annotate' });
      const result = await commitAndAppend(signed, dir, name, pki, retyping(SECOND));
      expect(result.report, name).toMatchObject({ applied: true });
      expect(result.signatures![0], name).toMatchObject({ intact: true, valid: true, policy_ok: true, modification_level: 'ANNOTATIONS' });
      const after = await reading(new Uint8Array(readFileSync(result.output)));
      expect(after.direct, name).toBe(direct);
      expect(Object.keys(after.fonts).sort(), name).toEqual(['Helv', 'LiberationSans', 'LiberationSans_1']);
      expect(after.fonts.LiberationSans, name).toBe(before.fonts.LiberationSans);
      expect(after.fonts.LiberationSans_1, name).toMatch(SUBSET);
      expect(after.fonts.LiberationSans_1, name).not.toBe(before.fonts.LiberationSans);
      expect(after.appearances, name).toHaveLength(1);
      expect(after.appearances[0], name).toContain('/LiberationSans_1 12 Tf');
    }
  }, 4 * RUN);
});

describe.skipIf(!HAS_BUNDLED_FACES)('a text box drawn again with the same text on a signed document', () => {
  let dir: string;
  let pki: Pki;
  beforeAll(() => {
    dir = mkdtempSync(resolve('text-box-redrawn.local.d-'));
    pki = buildPki(resolve(dir, 'pki'));
  }, RUN);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('takes the entry and the font the default resources hold: three revisions add no entry and no font program', async () => {
    const committed = await commit(await formDocument(false), adding(textBox(FIRST)));
    const before = await reading(committed);
    expect(Object.keys(before.fonts).sort()).toEqual(['Helv', 'LiberationSans']);
    expect(await fontPrograms(committed)).toBe(1);
    let signed = sign(committed, dir, 'redrawn.pdf', pki, { certify: true, certify_level: 'annotate' });
    for (const round of [1, 2, 3]) {
      const name = `redrawn-${round}.pdf`;
      const result = await commitAndAppend(signed, dir, name, pki, growing);
      expect(result.report, name).toMatchObject({ applied: true });
      expect(result.signatures, name).toHaveLength(1);
      expect(result.signatures![0], name).toMatchObject({ intact: true, valid: true, policy_ok: true, modification_level: 'ANNOTATIONS' });
      const appended = new Uint8Array(readFileSync(result.output));
      const after = await reading(appended);
      expect(after.fonts, name).toEqual(before.fonts);
      expect(after.appearances, name).toHaveLength(1);
      expect(after.appearances[0], name).toContain('/LiberationSans 12 Tf');
      expect(await fontPrograms(appended), name).toBe(1);
      signed = result.output;
    }
  }, 6 * RUN);

  it('takes the entry of an equal subset when its text returns to one an entry draws', async () => {
    const committed = await commit(await formDocument(false), adding(textBox(FIRST)));
    const before = await reading(committed);
    let signed = sign(committed, dir, 'returning.pdf', pki, { certify: true, certify_level: 'annotate' });
    const fonts: Record<string, string>[] = [];
    for (const [round, text] of [SECOND, FIRST, SECOND, FIRST].entries()) {
      const name = `returning-${round}.pdf`;
      const result = await commitAndAppend(signed, dir, name, pki, retyping(text));
      expect(result.report, name).toMatchObject({ applied: true });
      expect(result.signatures![0], name).toMatchObject({ intact: true, valid: true, policy_ok: true, modification_level: 'ANNOTATIONS' });
      const appended = new Uint8Array(readFileSync(result.output));
      const after = await reading(appended);
      fonts.push(after.fonts);
      expect(Object.keys(after.fonts).sort(), name).toEqual(['Helv', 'LiberationSans', 'LiberationSans_1']);
      expect(after.fonts.LiberationSans, name).toBe(before.fonts.LiberationSans);
      expect(after.appearances[0], name).toContain(text === FIRST ? '/LiberationSans 12 Tf' : '/LiberationSans_1 12 Tf');
      // One program per text: the revision of a text an entry draws holds no font.
      expect(await fontPrograms(appended), name).toBe(2);
      signed = result.output;
    }
    expect(new Set(fonts.map((held) => held.LiberationSans_1)).size).toBe(1);
  }, 8 * RUN);
});

describe.skipIf(!HAS_BUNDLED_FACES)('the default resource entry of a text box drawn again, with no signature', () => {
  it('leaves, so a second commit adds no entry', async () => {
    const committed = await commit(await formDocument(false), adding(textBox(FIRST)));
    const again = await commit(committed, retyping(SECOND));
    const [before, after] = [await reading(committed), await reading(again)];
    expect(Object.keys(after.fonts).sort()).toEqual(['Helv', 'LiberationSans']);
    expect(after.fonts.LiberationSans).not.toBe(before.fonts.LiberationSans);
    expect(after.appearances[0]).toContain('/LiberationSans 12 Tf');
  }, RUN);

  it('writes no second font object when the text box is drawn again from a font the default resources keep', async () => {
    const committed = await commit(await formDocument(false), adding(textBox(FIRST)));
    const doc = await PDFDocument.load(committed, { updateMetadata: false });
    const held = doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict);
    // A second name keeps the subset in the default resources through the redraw.
    held.set(N('Spare'), held.get(N('LiberationSans'))!);
    const spare = await doc.save({ useObjectStreams: false });
    expect(await fontObjects(spare)).toEqual({ programs: 1, composite: 1 });
    const again = await commit(spare, growing);
    // The build embeds an equal subset, takes the held object for it, and
    // the copy it made is not an object of the saved file.
    expect(await fontObjects(again)).toEqual({ programs: 1, composite: 1 });
    const read = await reading(again);
    expect(Object.keys(read.fonts).sort()).toEqual(['Helv', 'LiberationSans', 'Spare']);
    const saved = await PDFDocument.load(again, { updateMetadata: false });
    const fonts = saved.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict);
    expect(fonts.get(N('LiberationSans'))).toBe(fonts.get(N('Spare')));
    const twice = await commit(again, growing);
    expect(await fontObjects(twice)).toEqual({ programs: 1, composite: 1 });
  }, 2 * RUN);

  it('stays when an appearance stream draws from it through the default resources', async () => {
    const committed = await commit(await formDocument(false), adding(textBox(FIRST)));
    const doc = await PDFDocument.load(committed, { updateMetadata: false });
    const widget = doc.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict);
    expect(String(widget.lookup(N('Subtype')))).toBe('/Widget');
    // An appearance with no font of its own: a reader resolves the name in /DR.
    const stream = doc.context.register(doc.context.stream('BT /LiberationSans 10 Tf <0001> Tj ET', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 30], Resources: {},
    }));
    widget.set(N('AP'), doc.context.obj({ N: stream }));
    const inherited = await doc.save({ useObjectStreams: false });
    const before = await reading(inherited);
    const after = await reading(await commit(inherited, retyping(SECOND)));
    expect(Object.keys(after.fonts).sort()).toEqual(['Helv', 'LiberationSans', 'LiberationSans_1']);
    expect(after.fonts.LiberationSans).toBe(before.fonts.LiberationSans);
    expect(after.appearances[0]).toContain('/LiberationSans_1 12 Tf');
  }, RUN);

  it('stays when the build did not draw again the text box that named it', async () => {
    const committed = await commit(await formDocument(false), adding(textBox(FIRST)));
    const doc = await PDFDocument.load(committed, { updateMetadata: false });
    const held = doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict);
    // A second name for the subset, which no default appearance selects.
    held.set(N('Spare'), held.get(N('LiberationSans'))!);
    const spare = await doc.save({ useObjectStreams: false });
    const before = await reading(spare);
    const added = await reading(await commit(spare, adding(textBox(SECOND, { id: 'second', y: 0.4 }))));
    expect(added.fonts.Spare).toBe(before.fonts.Spare);
    expect(added.fonts.LiberationSans).toBe(before.fonts.LiberationSans);
    const retyped = await reading(await commit(spare, retyping(SECOND)));
    expect(retyped.fonts.Spare).toBe(before.fonts.Spare);
    expect(Object.keys(retyped.fonts).sort()).toEqual(['Helv', 'LiberationSans', 'Spare']);
    expect(retyped.fonts.LiberationSans).not.toBe(before.fonts.LiberationSans);
  }, RUN);
});
