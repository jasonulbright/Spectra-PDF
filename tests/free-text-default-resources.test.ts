// A free text annotation's /DA is a variable-text default appearance string
// (ISO 32000-2 12.5.6.6, Table 177). Its font is a name in /Font of the
// interactive form's default resources (12.7.4.3). A commit that writes a text
// box, a callout or a legend writes that entry; a commit that carries an
// input which already lacks an entry carries it as written.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
import { defaultAppearanceFonts, defaultAppearanceString } from '../src/renderer/lib/annotation-default-resources';
import { commit, deleting } from './support/commit-cycle';
import { annotsOf, expectSound, qpdfReading, subtypeOf } from './support/saved-pdf';
import { testPython } from './support/python';

const N = PDFName.of;
// A test that starts the oracle several times can pass the default limit on
// a loaded machine; each run stays bounded by the oracle's own limit.
const PYTHON_RUNS = 30_000;

async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 600]);
  return doc.save();
}

const placing = (...added: Omit<PageAnnotation, 'id'>[]) => ([page, ...rest]: PageRef[]): PageRef[] =>
  [{ ...page, annotations: [...(page.annotations ?? []), ...added.map((a, i) => ({ id: `placed-${i}`, ...a }))] }, ...rest];

const TEXT_BOX: Omit<PageAnnotation, 'id'> = { kind: 'freetext', x: 0.1, y: 0.1, w: 0.4, h: 0.1, color: '#14213d', note: 'Text box' };
const CALLOUT: Omit<PageAnnotation, 'id'> = {
  kind: 'callout', x: 0.1, y: 0.3, w: 0.6, h: 0.2, color: '#14213d', note: 'Callout',
  calloutBox: [0.4, 0.3, 0.3, 0.1], points: [0.1, 0.5, 0.3, 0.4, 0.4, 0.35],
};
const LEGEND: Omit<PageAnnotation, 'id'> = {
  kind: 'countlegend', x: 0.1, y: 0.6, w: 0.5, h: 0.2, color: '#14213d', note: 'Legend',
  legendTitle: 'Counts', legendTotalWord: 'Total', legendRows: [{ group: 'Doors', color: '#e0393e', symbol: 'circle', count: 3 }],
};
const HIGHLIGHT: Omit<PageAnnotation, 'id'> = { kind: 'highlight', x: 0.1, y: 0.85, w: 0.2, h: 0.05, color: '#ffd54a' };

interface FormReading {
  /** Whether the catalog holds the form dictionary by reference. */
  indirect: boolean;
  fields: number;
  /** Font resource name → /BaseFont. */
  fonts: Record<string, string>;
}

async function formOf(bytes: Uint8Array): Promise<FormReading | undefined> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.catalog.lookup(N('AcroForm'));
  if (!(form instanceof PDFDict)) return undefined;
  const table = form.lookupMaybe(N('DR'), PDFDict)?.lookupMaybe(N('Font'), PDFDict);
  const fonts: Record<string, string> = {};
  for (const name of table?.keys() ?? []) fonts[String(name)] = String(table!.lookup(name, PDFDict).get(N('BaseFont')));
  return { indirect: doc.catalog.get(N('AcroForm')) instanceof PDFRef, fields: form.lookupMaybe(N('Fields'), PDFArray)?.size() ?? 0, fonts };
}

/** The raw bytes of each free text /DA, as characters. */
async function freeTextAppearances(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return annotsOf(doc).filter((a) => subtypeOf(a.dict) === '/FreeText').map((a) => {
    const text = a.dict.lookup(N('DA'));
    return text instanceof PDFString || text instanceof PDFHexString ? String.fromCharCode(...text.asBytes()) : '';
  });
}

/** A page with a free text annotation of another producer whose /DA selects
 *  `font`. `held` puts that font in the form's default resources; the form
 *  has no field. The annotation is a callout with a line ending the import
 *  does not author, so the commit leaves it as written; `plain` makes it a
 *  text box, which the commit writes again. */
async function foreignFreeText(font: string, held: boolean, plain = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const face = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' }));
  const appearance = doc.context.register(doc.context.stream('BT /F0 10 Tf 2 5 Td (Foreign) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F0: face } },
  }));
  const annotation = doc.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [50, 400, 150, 420], F: 4, AP: { N: appearance } });
  annotation.set(N('DA'), PDFString.of(`0 g /${font} 10 Tf`));
  annotation.set(N('Contents'), PDFString.of('Foreign'));
  if (!plain) {
    annotation.set(N('IT'), N('FreeTextCallout'));
    annotation.set(N('CL'), doc.context.obj([20, 380, 40, 400, 50, 410]));
    annotation.set(N('LE'), N('Diamond'));
  }
  page.node.set(N('Annots'), doc.context.obj([doc.context.register(annotation)]));
  if (held) doc.catalog.set(N('AcroForm'), doc.context.register(doc.context.obj({ Fields: [], DR: { Font: { [font]: face } } })));
  return doc.save();
}

describe('the font names a default appearance string selects', () => {
  it('reads each Tf operand and nothing else', () => {
    const names = (text: string): string[] => defaultAppearanceFonts(text).map(String);
    expect(names('0.1 0.2 0.3 rg /Helv 12 Tf')).toEqual(['/Helv']);
    expect(names('/HelvB 0 Tf 0 g')).toEqual(['/HelvB']);
    expect(names('/F1 .5 Tf /F2 -3 Tf')).toEqual(['/F1', '/F2']);
    expect(names('/Arial#20Bold 9 Tf')).toEqual([String(N('Arial#20Bold'))]);
    expect(names('0 g')).toEqual([]);
    expect(names('/Helv 12 TfX')).toEqual([]);
    expect(names('/CS0 cs 1 scn')).toEqual([]);
  });

  it('writes the string one byte per character', () => {
    expect(defaultAppearanceString('0 g /Helv 9 Tf').asBytes()).toEqual(Uint8Array.from(Buffer.from('0 g /Helv 9 Tf', 'latin1')));
    expect(defaultAppearanceString('0 g /Helv 9 Tf').decodeText()).toBe('0 g /Helv 9 Tf');
  });
});

describe('a free text annotation this build writes', () => {
  it.each<[string, Omit<PageAnnotation, 'id'>]>([
    ['a text box', TEXT_BOX],
    ['a callout', CALLOUT],
    ['a legend', LEGEND],
  ])('%s names a font the form default resources hold', async (_label, annotation) => {
    const once = await commit(await blank(), placing(annotation));
    const reading = await expectSound(once);
    expect(reading.used.form_fonts).toBe(1);
    expect(await formOf(once)).toEqual({ indirect: true, fields: 0, fonts: { '/Helv': '/Helvetica' } });
    const [appearance] = await freeTextAppearances(once);
    expect(appearance).toMatch(/^[\d. ]+rg \/Helv [\d.]+ Tf$/);
  });

  it('keeps one entry through further commits and with three annotations', async () => {
    const once = await commit(await blank(), placing(TEXT_BOX, CALLOUT, LEGEND));
    const twice = await commit(once, placing(HIGHLIGHT));
    const thrice = await commit(twice, ([page, ...rest]) =>
      [{ ...page, annotations: page.annotations!.map((a) => (a.kind === 'freetext' ? { ...a, note: 'Edited' } : a)) }, ...rest]);
    for (const bytes of [once, twice, thrice]) {
      expect((await expectSound(bytes)).used.form_fonts).toBe(3);
      expect(await formOf(bytes)).toEqual({ indirect: true, fields: 0, fonts: { '/Helv': '/Helvetica' } });
    }
  }, PYTHON_RUNS);

  it('leaves no form behind when its last free text annotation is deleted', async () => {
    const once = await commit(await blank(), placing(TEXT_BOX));
    const emptied = await commit(once, ([page, ...rest]) => [deleting(page, () => true), ...rest]);
    await expectSound(emptied);
    expect(await formOf(emptied)).toBeUndefined();
  });

  it('takes a name of its own when a form of the input holds another font under Helv', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const own = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman' }));
    doc.getForm().createTextField('name').addToPage(page, { x: 20, y: 100, width: 120, height: 20 });
    doc.getForm().acroForm.dict.set(N('DR'), doc.context.obj({ Font: { Helv: own, Helvetica: doc.getForm().getDefaultFont().ref } }));
    const source = await doc.save();
    const once = await commit(source, placing(TEXT_BOX));
    await expectSound(once);
    expect(await formOf(once)).toEqual({
      indirect: true, fields: 1, fonts: { '/Helv': '/Times-Roman', '/Helv_1': '/Helvetica', '/Helvetica': '/Helvetica' },
    });
    expect((await freeTextAppearances(once))[0]).toMatch(/^[\d. ]+rg \/Helv_1 [\d.]+ Tf$/);
  });
});

describe('a free text annotation of the input', () => {
  it('keeps the default resource entry its form holds, with no field in the form', async () => {
    const source = await foreignFreeText('Cour', true);
    await expectSound(source);
    const once = await commit(source, placing(HIGHLIGHT));
    await expectSound(once);
    expect(await formOf(once)).toEqual({ indirect: true, fields: 0, fonts: { '/Cour': '/Courier' } });
    const withBox = await commit(source, placing(TEXT_BOX));
    await expectSound(withBox);
    expect((await formOf(withBox))!.fonts).toEqual({ '/Cour': '/Courier', '/Helv': '/Helvetica' });
  }, PYTHON_RUNS);

  it('that the commit writes again as a text box names the font this builder writes, which resolves', async () => {
    const source = await foreignFreeText('Ghost', false, true);
    expect(qpdfReading(source).default_fonts).toEqual(['free text /DA: /Font /Ghost']);
    const once = await commit(source, placing(HIGHLIGHT));
    await expectSound(once);
    expect((await freeTextAppearances(once))[0]).toMatch(/ \/Helv [\d.]+ Tf$/);
    expect((await formOf(once))!.fonts).toEqual({ '/Helv': '/Helvetica' });
  });

  it('whose font no default resource holds is carried as written, and the oracle names the input as the cause', async () => {
    const source = await foreignFreeText('Ghost', false);
    const before = qpdfReading(source);
    expect(before.default_fonts).toEqual(['free text /DA: /Font /Ghost']);
    const once = await commit(source, placing(HIGHLIGHT));
    expect(await formOf(once)).toBeUndefined();
    expect(await freeTextAppearances(once)).toEqual(['0 g /Ghost 10 Tf']);
    expect((await expectSound(once, [], undefined, before)).default_fonts).toEqual(before.default_fonts);
    // A text box beside it resolves; the input's own miss stays the input's.
    const withBox = await commit(source, placing(TEXT_BOX));
    expect((await formOf(withBox))!.fonts).toEqual({ '/Helv': '/Helvetica' });
    expect((await expectSound(withBox, [], undefined, before)).default_fonts).toEqual(before.default_fonts);
  }, PYTHON_RUNS);
});

describe('a form of the input whose field names a font outside the default resources', () => {
  async function brokenForm(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    doc.getForm().createTextField('older').addToPage(page, { x: 20, y: 300, width: 120, height: 20 });
    doc.getForm().createCheckBox('tick').addToPage(page, { x: 20, y: 340, width: 12, height: 12 });
    return doc.save();
  }
  const fieldAppearances = async (bytes: Uint8Array): Promise<string[]> => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getForm().getFields().map((field) => {
      const text = field.acroField.dict.lookup(N('DA'));
      return `${field.getName()}: ${text instanceof PDFString || text instanceof PDFHexString ? text.decodeText() : ''}`;
    });
  };

  it('is carried by a page-tier commit as written: nothing thrown, nothing more unresolved', async () => {
    const source = await brokenForm();
    const before = qpdfReading(source);
    expect(before.default_fonts).toEqual(['field older /DA: /Font /Helvetica', 'field tick /DA: /Font /dummy__noop']);
    const once = await commit(source, placing(HIGHLIGHT));
    const twice = await commit(once, placing(HIGHLIGHT));
    for (const bytes of [once, twice]) {
      expect(await fieldAppearances(bytes)).toEqual(await fieldAppearances(source));
      expect(await formOf(bytes)).toEqual({ indirect: true, fields: 2, fonts: {} });
      expect((await expectSound(bytes, [], undefined, before)).default_fonts).toEqual(before.default_fonts);
    }
    // Without the input the same file fails: the miss is reported, not hidden.
    await expect(expectSound(once)).rejects.toThrow();
  }, PYTHON_RUNS);

  it('gains only the entry of a text box placed beside it', async () => {
    const source = await brokenForm();
    const once = await commit(source, placing(TEXT_BOX));
    const before = qpdfReading(source);
    expect((await formOf(once))!.fonts).toEqual({ '/Helv': '/Helvetica' });
    expect((await expectSound(once, [], undefined, before)).default_fonts).toEqual(before.default_fonts);
  }, PYTHON_RUNS);
});

describe('the comparison with the input', () => {
  it('fails a save that drops a default resource entry the input held', async () => {
    const source = await foreignFreeText('Cour', true);
    const doc = await PDFDocument.load(source, { updateMetadata: false });
    doc.catalog.delete(N('AcroForm'));
    const dropped = await doc.save();
    expect(qpdfReading(dropped).default_fonts).toEqual(['free text /DA: /Font /Cour']);
    await expect(expectSound(dropped, [], undefined, source)).rejects.toThrow();
  });

  it('fails a save that adds an annotation with an unresolved font beside one the input held unresolved', async () => {
    const source = await foreignFreeText('Ghost', false);
    const doc = await PDFDocument.load(source, { updateMetadata: false });
    const added = doc.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [50, 300, 150, 320], F: 4 });
    added.set(N('DA'), PDFString.of('/Other 10 Tf'));
    doc.getPage(0).node.lookup(N('Annots'), PDFArray).push(doc.context.register(added));
    await expect(expectSound(await doc.save(), [], undefined, source)).rejects.toThrow();
  });

  it('names a default appearance written with a byte order mark', async () => {
    const source = await foreignFreeText('Cour', true);
    const doc = await PDFDocument.load(source, { updateMetadata: false });
    annotsOf(doc)[0].dict.set(N('DA'), PDFHexString.fromText('0 g /Cour 10 Tf'));
    expect(qpdfReading(await doc.save()).missing).toEqual(['free text /DA: starts with a byte order mark']);
  });
});

describe('a form the commit carries', () => {
  it('keeps the form default appearance a byte string', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const form = doc.getForm();
    form.createTextField('name').addToPage(page, { x: 20, y: 100, width: 120, height: 20 });
    form.acroForm.dict.set(N('DR'), doc.context.obj({ Font: { Helvetica: form.getDefaultFont().ref, Helv: form.getDefaultFont().ref } }));
    form.acroForm.dict.set(N('DA'), PDFString.of('/Helv 0 Tf 0 g'));
    const once = await commit(await doc.save(), placing(HIGHLIGHT));
    await expectSound(once);
    const text = (await PDFDocument.load(once, { updateMetadata: false })).catalog.lookup(N('AcroForm'), PDFDict).lookup(N('DA'));
    expect(text instanceof PDFString || text instanceof PDFHexString ? String.fromCharCode(...text.asBytes()) : '').toBe('/Helv 0 Tf 0 g');
  });
});

describe('a signed document', () => {
  const SIGNED = resolve('e2e-tests/fixtures/signed.pdf');
  const signedPages = (bytes: Uint8Array) => [{ bytes, sourceKey: SIGNED, pageIndex: 0, annotations: [{ ...TEXT_BOX }] }];

  it('whose form dictionary is an object gains the entry, and the incremental append keeps the signed bytes', async () => {
    const original = new Uint8Array(readFileSync(SIGNED));
    expect(await formOf(original)).toMatchObject({ indirect: true, fonts: {} });
    const built = await buildPdf(signedPages(original), original, SIGNED);
    expect((await formOf(built))!.fonts).toEqual({ '/Helv': '/Helvetica' });
    const directory = mkdtempSync(resolve('free-text-resources.local.d-'));
    try {
      const modified = resolve(directory, 'modified.pdf'), output = resolve(directory, 'output.pdf');
      writeFileSync(modified, built);
      const report = JSON.parse(execFileSync(testPython(), ['-B', '-c',
        'import json,sys; from engine.incremental import transplant_incremental; print(json.dumps(transplant_incremental(*sys.argv[1:4])))',
        SIGNED, modified, output],
      { env: { ...process.env, PYTHONPATH: resolve('src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 15_000 })) as unknown;
      expect(report).toMatchObject({ applied: true });
      const appended = new Uint8Array(readFileSync(output));
      expect(Buffer.from(appended.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
      expect((await formOf(appended))!.fonts).toEqual({ '/Helv': '/Helvetica' });
      expect((await freeTextAppearances(appended)).length).toBe(1);
      expect(qpdfReading(appended).default_fonts).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('whose form dictionary is written in the catalog gains the entry there, in a revision of the catalog', async () => {
    const doc = await PDFDocument.load(readFileSync(SIGNED), { updateMetadata: false });
    doc.catalog.set(N('AcroForm'), doc.catalog.lookup(N('AcroForm'), PDFDict));
    const direct = await doc.save({ useObjectStreams: false });
    expect(await formOf(direct)).toMatchObject({ indirect: false, fonts: {} });
    const built = await buildPdf(signedPages(direct), direct, SIGNED);
    expect((await formOf(built))!.fonts).toEqual({ '/Helv': '/Helvetica' });
    const directory = mkdtempSync(resolve('free-text-resources.local.d-'));
    try {
      const original = resolve(directory, 'original.pdf'), modified = resolve(directory, 'modified.pdf'), output = resolve(directory, 'output.pdf');
      writeFileSync(original, direct);
      writeFileSync(modified, built);
      const report = JSON.parse(execFileSync(testPython(), ['-B', '-c',
        'import json,sys; from engine.incremental import transplant_incremental; print(json.dumps(transplant_incremental(*sys.argv[1:4])))',
        original, modified, output],
      { env: { ...process.env, PYTHONPATH: resolve('src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 15_000 })) as unknown;
      expect(report).toMatchObject({ applied: true, delta_classes: ['form-fill', 'annotations'] });
      const appended = new Uint8Array(readFileSync(output));
      expect(Buffer.from(appended.subarray(0, direct.length)).equals(Buffer.from(direct))).toBe(true);
      // The form dictionary stays where it was written.
      expect(await formOf(appended)).toMatchObject({ indirect: false, fonts: { '/Helv': '/Helvetica' } });
      expect((await freeTextAppearances(appended)).length).toBe(1);
      expect(qpdfReading(appended).default_fonts).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
