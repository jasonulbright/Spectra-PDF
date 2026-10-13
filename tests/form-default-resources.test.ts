// A default appearance string names its font by a resource name, and a viewer
// that redraws the field resolves that name in the default resources of the
// interactive form dictionary (ISO 32000-2 12.7.4.3). Field creation leaves
// every such name resolvable, whatever form the document had before.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { addFormFields } from '../src/renderer/lib/form-authoring';
import type { NewFieldSpec } from '../src/renderer/lib/form-authoring';
import { expectSound, qpdfReading } from './support/saved-pdf';
import { testPython } from './support/python';

const N = PDFName.of;
const TEXT_FIELD: NewFieldSpec = { name: 'added', type: 'text', pageIndex: 0, rect: [20, 100, 140, 120] };

/** One page and a text field written by hand: the field and the form each
 *  carry a default appearance, and the form's default resources hold its font
 *  under a name of the document's own. */
async function withFormAndResources(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman' }));
  const appearance = ctx.register(ctx.stream('/Tx BMC EMC', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 20] }));
  const field = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Rect: [20, 300, 140, 320], P: page.ref, AP: { N: appearance } });
  field.set(N('T'), PDFString.of('existing'));
  field.set(N('DA'), PDFString.of('/OwnTimes 11 Tf 0 g'));
  const fieldRef = ctx.register(field);
  page.node.set(N('Annots'), ctx.obj([fieldRef]));
  const form = ctx.obj({ Fields: [fieldRef], DR: { Font: { OwnTimes: font } } });
  form.set(N('DA'), PDFString.of('/OwnTimes 0 Tf 0 g'));
  doc.catalog.set(N('AcroForm'), ctx.register(form));
  return doc.save();
}

async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 600]);
  return doc.save();
}

/** `bytes` with every field and its widgets removed by qpdf, and the form
 *  dictionary left in place. */
function withoutFields(bytes: Uint8Array): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), 'spectra-form-fonts-'));
  try {
    const source = join(directory, 'in.pdf'), target = join(directory, 'out.pdf');
    writeFileSync(source, bytes);
    execFileSync(testPython(), ['-B', '-c', [
      'import sys, pikepdf',
      'pdf = pikepdf.open(sys.argv[1])',
      'for page in pdf.pages:',
      '    page.obj["/Annots"] = pikepdf.Array([a for a in page.obj.get("/Annots", []) if a.get("/Subtype") != "/Widget"])',
      'pdf.Root.AcroForm.Fields = pikepdf.Array()',
      'pdf.save(sys.argv[2])',
    ].join('\n'), source, target], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return new Uint8Array(readFileSync(target));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const formOf = async (bytes: Uint8Array): Promise<PDFDict> => (await PDFDocument.load(bytes)).catalog.lookup(N('AcroForm'), PDFDict);
const defaultFonts = (form: PDFDict): string[] =>
  (form.lookupMaybe(N('DR'), PDFDict)?.lookupMaybe(N('Font'), PDFDict)?.keys() ?? []).map(String).sort();

describe('a new field on a document', () => {
  it('with a form and default resources keeps them and adds the font its own default appearance names', async () => {
    const source = await withFormAndResources();
    expect(qpdfReading(source)).toMatchObject({ missing: [], used: { form_fonts: 2 } });
    const saved = await addFormFields(source, [TEXT_FIELD]);
    const reading = await expectSound(saved);
    expect(reading.used.form_fonts).toBe(3);
    const form = await formOf(saved);
    expect(defaultFonts(form)).toEqual(['/Helvetica', '/OwnTimes']);
    expect(form.lookup(N('DA'), PDFString).asString()).toBe('/OwnTimes 0 Tf 0 g');
  });

  it('with no form gets a form whose default resources hold the font', async () => {
    const saved = await addFormFields(await blank(), [TEXT_FIELD]);
    const reading = await expectSound(saved);
    expect(reading.used.form_fonts).toBeGreaterThan(0);
    expect(defaultFonts(await formOf(saved))).toContain('/Helvetica');
  });

  it('whose only field was deleted, with the form left in place', async () => {
    const emptied = withoutFields(await addFormFields(await blank(), [{ ...TEXT_FIELD, name: 'first' }]));
    expect((await PDFDocument.load(emptied)).getForm().getFields()).toEqual([]);
    await expectSound(emptied);
    const saved = await addFormFields(emptied, [TEXT_FIELD]);
    expect((await expectSound(saved)).used.form_fonts).toBeGreaterThan(0);
    expect((await PDFDocument.load(saved)).getForm().getFields().map((field) => field.getName())).toEqual(['added']);
  });

  it('whose only field was deleted with the default resources, and the form default appearance left', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 600]);
    const form = doc.context.obj({ Fields: [] });
    form.set(N('DA'), PDFString.of('/Helv 0 Tf 0 g'));
    doc.catalog.set(N('AcroForm'), doc.context.register(form));
    const emptied = await doc.save();
    expect(qpdfReading(emptied).missing).toEqual(['form /DA: /Font /Helv']);
    const saved = await addFormFields(emptied, [TEXT_FIELD]);
    expect((await expectSound(saved)).used.form_fonts).toBe(2);
    expect(defaultFonts(await formOf(saved))).toEqual(['/Helv', '/Helvetica']);
  });

  it.each<[string, NewFieldSpec]>([
    ['a checkbox', { name: 'c', type: 'checkbox', pageIndex: 0, rect: [20, 100, 40, 120] }],
    ['a radio group', { name: 'r', type: 'radio', pageIndex: 0, rect: [20, 100, 140, 120], options: [{ label: 'a' }, { label: 'b' }] }],
    ['a dropdown', { name: 'd', type: 'dropdown', pageIndex: 0, rect: [20, 100, 140, 120], options: [{ label: 'a' }, { label: 'b' }] }],
    ['an option list', { name: 'o', type: 'optionlist', pageIndex: 0, rect: [20, 100, 140, 160], options: [{ label: 'a' }, { label: 'b' }] }],
    ['a signature field', { name: 's', type: 'signature', pageIndex: 0, rect: [20, 100, 140, 160] }],
  ])('%s resolves every default appearance font', async (_label, spec) => {
    await expectSound(await addFormFields(await blank(), [spec]));
  });

  it('a field of the input whose font only its appearance holds gains the default resource entry', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    doc.getForm().createTextField('older').addToPage(page, { x: 20, y: 300, width: 120, height: 20 });
    const source = await doc.save();
    expect(qpdfReading(source).missing).toEqual(['field older /DA: /Font /Helvetica']);
    const saved = await addFormFields(source, [TEXT_FIELD]);
    expect((await expectSound(saved)).used.form_fonts).toBe(2);
    const fields = (await formOf(saved)).lookup(N('Fields'), PDFArray);
    expect(fields.size()).toBe(2);
  });
});

describe('a new field on a document whose default resources hold another font under its name', () => {
  /** A form with no field: the names the field provider and the engine-drawn
   *  list select each hold a font of a carried annotation. */
  async function heldNames(fonts: Record<string, Record<string, string>>): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([300, 600]);
    const table = doc.context.obj({});
    for (const [name, font] of Object.entries(fonts)) table.set(N(name), doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', ...font })));
    doc.catalog.set(N('AcroForm'), doc.context.register(doc.context.obj({ Fields: [], DR: { Font: table } })));
    return doc.save();
  }

  const TIMES = { BaseFont: 'Times-Roman' };
  const COURIER = { BaseFont: 'Courier' };
  const CHECK: NewFieldSpec = { name: 'check', type: 'checkbox', pageIndex: 0, rect: [20, 200, 40, 220] };
  const LIST: NewFieldSpec = { name: 'list', type: 'optionlist', pageIndex: 0, rect: [20, 300, 140, 360], options: [{ label: '日本' }, { label: 'b' }] };

  const baseFonts = (form: PDFDict): Record<string, string> => {
    const fonts = form.lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict);
    return Object.fromEntries(fonts.keys().map((key) => [key.decodeText(), fonts.lookup(key, PDFDict).lookup(N('BaseFont'), PDFName).decodeText()]));
  };
  const appearances = (form: PDFDict): Record<string, string> => {
    const fields = form.lookup(N('Fields'), PDFArray);
    return Object.fromEntries(fields.asArray().map((_, index) => {
      const field = fields.lookup(index, PDFDict);
      const text = (key: string): string => (field.lookup(N(key)) as PDFString).decodeText();
      return [text('T'), text('DA')];
    }));
  };
  const selected = (da: string): string => /\/(\S+)\s+[\d.]+\s+Tf/.exec(da)![1];

  it('leaves the entry as it is and gives the field its font under a name of its own', async () => {
    const source = await heldNames({ Helvetica: TIMES, Helv: TIMES, ZaDb: COURIER });
    const saved = await addFormFields(source, [TEXT_FIELD, CHECK, LIST]);
    await expectSound(saved);
    const form = await formOf(saved);
    expect(baseFonts(form)).toEqual({
      Helvetica: 'Times-Roman', Helv: 'Times-Roman', ZaDb: 'Courier',
      Helvetica_1: 'Helvetica', Helv_1: 'Helvetica', ZaDb_1: 'ZapfDingbats',
    });
    const written = appearances(form);
    expect([selected(written.added), selected(written.check), selected(written.list)]).toEqual(['Helvetica_1', 'ZaDb_1', 'Helv_1']);

    // A second batch reuses the names.
    const again = await addFormFields(saved, [{ ...TEXT_FIELD, name: 'more' }, { ...CHECK, name: 'tick' }]);
    await expectSound(again);
    const next = await formOf(again);
    expect(Object.keys(baseFonts(next)).sort()).toEqual(['Helv', 'Helv_1', 'Helvetica', 'Helvetica_1', 'ZaDb', 'ZaDb_1']);
    const rewritten = appearances(next);
    expect([selected(rewritten.more), selected(rewritten.tick)]).toEqual(['Helvetica_1', 'ZaDb_1']);
    // The fields of the first batch keep the names they have.
    expect([selected(rewritten.added), selected(rewritten.check), selected(rewritten.list)]).toEqual(['Helvetica_1', 'ZaDb_1', 'Helv_1']);
  });

  it('shares a name that holds the standard face', async () => {
    const source = await heldNames({
      Helvetica: { BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' },
      ZaDb: { BaseFont: 'ZapfDingbats' },
    });
    const saved = await addFormFields(source, [TEXT_FIELD, CHECK]);
    await expectSound(saved);
    const form = await formOf(saved);
    expect(baseFonts(form)).toEqual({ Helvetica: 'Helvetica', ZaDb: 'ZapfDingbats' });
    const written = appearances(form);
    expect([selected(written.added), selected(written.check)]).toEqual(['Helvetica', 'ZaDb']);
  });

  it('never renames the default appearance of a field the document already had', async () => {
    const source = await withFormAndResources();
    const doc = await PDFDocument.load(source);
    const fonts = doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict);
    fonts.set(N('Helvetica'), fonts.get(N('OwnTimes'))!);
    const saved = await addFormFields(await doc.save(), [TEXT_FIELD]);
    const written = appearances(await formOf(saved));
    expect([selected(written.existing), selected(written.added)]).toEqual(['OwnTimes', 'Helvetica_1']);
  });
});
