// AcroForm preservation through the from-scratch rebuild (2n.4a). The
// page-tier commit rebuilds dirty files via buildPdf/buildPdfx; before
// lib/acroform-carry.ts existed that rebuild dropped /AcroForm entirely —
// fields kept rendering (copied widget /AP pixels) but nothing was fillable
// and every /V was orphaned. These tests drive the REAL builders over
// pdf-lib-authored and hand-assembled fixtures and read the results back
// through the app's own reader (readFormFields) plus independent pdf.js
// checks for baked values.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFBool,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import { readFormFields, fillFormFields } from '../src/renderer/lib/forms';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

function pagesOf(
  bytes: Uint8Array,
  sourceKey: string,
  indices: number[],
  rotation?: 0 | 90 | 180 | 270,
): ExportPage[] {
  return indices.map((pageIndex) => ({ bytes, sourceKey, pageIndex, rotation }));
}

// 3-page form exercising every widget topology the carry must preserve:
// single-widget fields, a MULTI-widget field whose root is shared by widgets
// on two different pages (the shape per-page copyPages calls would fork), a
// radio group spanning pages, and a field that exists only on the last page.
async function makeMultiPageForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p0 = doc.addPage([600, 800]);
  const p1 = doc.addPage([600, 800]);
  const p2 = doc.addPage([600, 800]);
  const form = doc.getForm();

  const title = form.createTextField('title');
  title.setText('Hello');
  title.addToPage(p0, { x: 50, y: 700, width: 200, height: 20 });

  const everywhere = form.createTextField('everywhere');
  everywhere.setText('shared');
  everywhere.addToPage(p0, { x: 50, y: 650, width: 200, height: 20 });
  everywhere.addToPage(p2, { x: 50, y: 650, width: 200, height: 20 });

  const ok = form.createCheckBox('ok');
  ok.check();
  ok.addToPage(p1, { x: 50, y: 700, width: 15, height: 15 });

  const color = form.createRadioGroup('color');
  color.addOptionToPage('red', p0, { x: 50, y: 600, width: 15, height: 15 });
  color.addOptionToPage('blue', p2, { x: 50, y: 600, width: 15, height: 15 });
  color.select('blue');

  const country = form.createDropdown('country');
  country.addOptions(['USA', 'Canada']);
  country.addToPage(p1, { x: 50, y: 650, width: 120, height: 20 });
  country.select('Canada');

  const tail = form.createTextField('only-p2');
  tail.setText('tail');
  tail.addToPage(p2, { x: 50, y: 500, width: 120, height: 20 });

  return doc.save();
}

// A widget-less pure-data field (no visual presence on any page) appended at
// the low level — pdf-lib's high-level API can't author one.
async function withPureDataField(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
  const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
  const field = doc.context.obj({ FT: 'Tx' }) as PDFDict;
  field.set(PDFName.of('T'), PDFHexString.fromText('hidden-data'));
  field.set(PDFName.of('V'), PDFHexString.fromText('ghost'));
  fields.push(doc.context.register(field));
  return doc.save();
}

async function fieldMap(bytes: Uint8Array) {
  const { fields } = await readFormFields(bytes);
  return new Map(fields.map((f) => [f.name, f]));
}

// Independent per-page widget read via pdf.js (fieldName -> fieldValue).
async function pdfjsFieldValues(bytes: Uint8Array, pageNumber: number): Promise<Map<string, unknown>> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const annots = (await (await pdf.getPage(pageNumber)).getAnnotations()) as {
    fieldName?: string;
    fieldValue?: unknown;
  }[];
  const map = new Map<string, unknown>();
  for (const a of annots) if (a.fieldName) map.set(a.fieldName, a.fieldValue);
  await pdf.loadingTask.destroy();
  return map;
}

async function acroFormDictOf(bytes: Uint8Array): Promise<PDFDict | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict) ?? null;
}

describe('AcroForm survives the page-tier rebuild', () => {
  it('keeps every field, value, and option through a full rebuild with a rotation', async () => {
    const src = await makeMultiPageForm();
    const rebuilt = await buildPdf(pagesOf(src, 'a', [0, 1, 2], 90));

    const m = await fieldMap(rebuilt);
    expect([...m.keys()].sort()).toEqual(
      ['color', 'country', 'everywhere', 'ok', 'only-p2', 'title'].sort(),
    );
    expect(m.get('title')).toMatchObject({ type: 'text', value: 'Hello', editable: true });
    expect(m.get('ok')).toMatchObject({ type: 'checkbox', value: true });
    expect(m.get('color')).toMatchObject({ type: 'radio', value: 'blue' });
    expect(m.get('color')!.options).toEqual(expect.arrayContaining(['red', 'blue']));
    expect(m.get('country')).toMatchObject({ type: 'dropdown', value: 'Canada' });

    // Independent pdf.js read of a baked /V straight off a widget.
    const p1 = await pdfjsFieldValues(rebuilt, 2);
    expect(p1.get('country')).toEqual(['Canada']);
  });

  it('copies a multi-widget field root ONCE (no forked same-name fields)', async () => {
    const src = await makeMultiPageForm();
    const rebuilt = await buildPdf(pagesOf(src, 'a', [0, 1, 2]));
    const doc = await PDFDocument.load(rebuilt, { ignoreEncryption: true });
    const fields = doc.getForm().getFields();
    const names = fields.map((f) => f.getName());
    expect(new Set(names).size).toBe(names.length); // no duplicates
    const everywhere = fields.find((f) => f.getName() === 'everywhere')!;
    expect(everywhere.acroField.getWidgets().length).toBe(2); // both widgets, one root
  });

  it('prunes fields to kept pages: dropped-page-only fields go, spanning fields survive', async () => {
    const src = await makeMultiPageForm();
    // Drop page 2 (index 2): 'only-p2' dies with it; 'everywhere' keeps its
    // p0 widget; 'color' keeps only the red option's widget.
    const rebuilt = await buildPdf(pagesOf(src, 'a', [0, 1]));
    const m = await fieldMap(rebuilt);
    expect(m.has('only-p2')).toBe(false);
    expect(m.get('everywhere')).toMatchObject({ type: 'text', value: 'shared' });
    expect(m.get('color')).toMatchObject({ type: 'radio' });
    const doc = await PDFDocument.load(rebuilt, { ignoreEncryption: true });
    const everywhere = doc.getForm().getFields().find((f) => f.getName() === 'everywhere')!;
    expect(everywhere.acroField.getWidgets().length).toBe(1);
    // No stray copies of the dropped page: exactly the two kept pages.
    expect(doc.getPageCount()).toBe(2);
  });

  it('keeps a widget-less pure-data field (its /V has no visual to lose)', async () => {
    const src = await withPureDataField(await makeMultiPageForm());
    const rebuilt = await buildPdf(pagesOf(src, 'a', [0])); // even a 1-page subset
    const m = await fieldMap(rebuilt);
    expect(m.get('hidden-data')).toMatchObject({ type: 'text', value: 'ghost' });
  });

  it('adds no /AcroForm to a rebuild of a non-form PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const rebuilt = await buildPdf(pagesOf(await doc.save(), 'a', [0]));
    expect(await acroFormDictOf(rebuilt)).toBeNull();
  });

  it('filling still works on rebuilt bytes (the real user flow)', async () => {
    const src = await makeMultiPageForm();
    const rebuilt = await buildPdf(pagesOf(src, 'a', [0, 1, 2]));
    const filled = await fillFormFields(rebuilt, { title: 'After rebuild', ok: false });
    const m = await fieldMap(filled);
    expect(m.get('title')).toMatchObject({ value: 'After rebuild' });
    expect(m.get('ok')).toMatchObject({ value: false });
    const vals = await pdfjsFieldValues(filled, 1);
    expect(vals.get('title')).toBe('After rebuild');
  });

  it('preserves fields through the .pdfx (manifest) builder too', async () => {
    const src = await makeMultiPageForm();
    const bytes = await buildPdfx(
      [
        { name: 'Front', pages: pagesOf(src, 'a', [0, 1]) },
        { name: 'Back', pages: pagesOf(src, 'a', [2]) },
      ],
      'Combined',
    );
    const m = await fieldMap(bytes);
    expect(m.get('title')).toMatchObject({ value: 'Hello' });
    expect(m.get('only-p2')).toMatchObject({ value: 'tail' });
  });
});

describe('multi-source rebuilds (the import machinery)', () => {
  async function makeNamedForm(fieldName: string, value: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const form = doc.getForm();
    const f = form.createTextField(fieldName);
    f.setText(value);
    f.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    return doc.save();
  }

  it('merges two form sources; colliding field names rename deterministically', async () => {
    const a = await makeNamedForm('name', 'from-A');
    const b = await makeNamedForm('name', 'from-B');
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);
    const m = await fieldMap(rebuilt);
    // Same name+1 convention as pikepdf's add_pages_from (engine merge/split).
    expect(m.get('name')).toMatchObject({ value: 'from-A' });
    expect(m.get('name+1')).toMatchObject({ value: 'from-B' });
    // Both stay independently fillable.
    const filled = await fillFormFields(rebuilt, { name: 'A2', 'name+1': 'B2' });
    const m2 = await fieldMap(filled);
    expect(m2.get('name')).toMatchObject({ value: 'A2' });
    expect(m2.get('name+1')).toMatchObject({ value: 'B2' });
  });

  it('reuses an equivalent /DR font and renames a conflicting face, rewriting /DA', async () => {
    // Source A: /DR /Font /F1 = Helvetica. Source B: /DR /Font /F1 = Courier
    // — same resource name, different face. B's field /DA references /F1 and
    // must be rewritten to the renamed entry, or its text changes face.
    async function withDrFont(fieldName: string, base: string): Promise<Uint8Array> {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 800]);
      const form = doc.getForm();
      const f = form.createTextField(fieldName);
      f.setText('x');
      f.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
      const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
      const fontDict = doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: base });
      const dr = doc.context.obj({ Font: { F1: doc.context.register(fontDict) } });
      acro.set(PDFName.of('DR'), dr);
      // Point the field's own /DA at /F1.
      const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
      const fieldDict = fields.lookup(0, PDFDict);
      fieldDict.set(PDFName.of('DA'), PDFHexString.fromText('/F1 10 Tf 0 g'));
      // setText marked the field dirty; a default save would regenerate its
      // appearance and REWRITE the hand-set /DA with pdf-lib's own font.
      return doc.save({ updateFieldAppearances: false });
    }
    const a = await withDrFont('fa', 'Helvetica');
    const b = await withDrFont('fb', 'Courier');
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);

    const acro = (await acroFormDictOf(rebuilt))!;
    const doc = await PDFDocument.load(rebuilt, { ignoreEncryption: true });
    const dr = acro.lookupMaybe(PDFName.of('DR'), PDFDict)!;
    const fonts = dr.lookupMaybe(PDFName.of('Font'), PDFDict)!;
    const f1 = fonts.lookupMaybe(PDFName.of('F1'), PDFDict)!;
    const f1r = fonts.lookupMaybe(PDFName.of('F1_1'), PDFDict)!;
    expect(f1.get(PDFName.of('BaseFont'))).toBe(PDFName.of('Helvetica'));
    expect(f1r.get(PDFName.of('BaseFont'))).toBe(PDFName.of('Courier'));
    // B's /DA follows the rename; A's is untouched.
    const byName = new Map(doc.getForm().getFields().map((f) => [f.getName(), f]));
    const daOf = (n: string): string => {
      const da = byName.get(n)!.acroField.dict.get(PDFName.of('DA'));
      return (da as PDFHexString).decodeText();
    };
    expect(daOf('fa')).toBe('/F1 10 Tf 0 g');
    expect(daOf('fb')).toBe('/F1_1 10 Tf 0 g');
  });

  // Flexible /DR fixture: one page, one text field per font entry, each
  // field's own /DA referencing its font key. Saved without appearance
  // regeneration so the hand-set /DA and /DR survive verbatim.
  async function withDrFonts(
    fonts: { key: string; base: string; encoding?: string; embedded?: boolean; fieldName: string }[],
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const form = doc.getForm();
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const fontGroup: Record<string, PDFRef> = {};
    let y = 700;
    for (const f of fonts) {
      const field = form.createTextField(f.fieldName);
      field.setText('x');
      field.addToPage(page, { x: 50, y, width: 200, height: 20 });
      y -= 40;
      const dict: Record<string, string | PDFRef> = { Type: 'Font', Subtype: 'Type1', BaseFont: f.base };
      if (f.encoding) dict.Encoding = f.encoding;
      if (f.embedded) dict.FontDescriptor = doc.context.register(doc.context.obj({ Type: 'FontDescriptor' }));
      fontGroup[f.key] = doc.context.register(doc.context.obj(dict));
      const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
      const fieldDict = fields.lookup(fields.size() - 1, PDFDict);
      fieldDict.set(PDFName.of('DA'), PDFHexString.fromText(`/${f.key} 10 Tf 0 g`));
    }
    acro.set(PDFName.of('DR'), doc.context.obj({ Font: fontGroup }));
    return doc.save({ updateFieldAppearances: false });
  }

  async function daByField(bytes: Uint8Array): Promise<Map<string, string>> {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const map = new Map<string, string>();
    for (const f of doc.getForm().getFields()) {
      const da = f.acroField.dict.get(PDFName.of('DA'));
      if (da instanceof PDFHexString || da instanceof PDFString) map.set(f.getName(), da.decodeText());
    }
    return map;
  }

  async function drBaseFonts(bytes: Uint8Array): Promise<Map<string, string>> {
    const acro = (await acroFormDictOf(bytes))!;
    const fonts = acro
      .lookupMaybe(PDFName.of('DR'), PDFDict)!
      .lookupMaybe(PDFName.of('Font'), PDFDict)!;
    const map = new Map<string, string>();
    for (const [k, v] of fonts.entries()) {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const dict = v instanceof PDFDict ? v : (doc.context.lookup(v) as PDFDict);
      map.set(k.decodeText(), (dict.get(PDFName.of('BaseFont')) as PDFName).decodeText());
    }
    return map;
  }

  it('chained renames rewrite each /DA exactly once — never onto another field\'s font (review #1)', async () => {
    // Source B renames F1 -> F1_1 while ALSO owning a pre-existing F1_1 that
    // renames to F1_1_1 — the natural shape of a document that already went
    // through one merge. The old sequential rewrite re-matched its own
    // output and landed fa on fb's font (verified live by the reviewer).
    const a = await withDrFonts([{ key: 'F1', base: 'Helvetica', fieldName: 'base' }]);
    const b = await withDrFonts([
      { key: 'F1', base: 'Times-Roman', fieldName: 'fa' },
      { key: 'F1_1', base: 'Courier', fieldName: 'fb' },
    ]);
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);

    const dr = await drBaseFonts(rebuilt);
    expect(dr.get('F1')).toBe('Helvetica');
    const da = await daByField(rebuilt);
    // fa and fb must reference DISTINCT keys whose faces are their own.
    const faKey = da.get('fa')!.match(/^\/(\S+) /)![1];
    const fbKey = da.get('fb')!.match(/^\/(\S+) /)![1];
    expect(faKey).not.toBe(fbKey);
    expect(dr.get(faKey)).toBe('Times-Roman');
    expect(dr.get(fbKey)).toBe('Courier');
  });

  it('font names containing $ rewrite literally (review #2)', async () => {
    // '$&' in a replacement STRING splices the matched text; the rewrite must
    // treat the new name literally.
    const a = await withDrFonts([{ key: 'F$&', base: 'Helvetica', fieldName: 'fa' }]);
    const b = await withDrFonts([{ key: 'F$&', base: 'Courier', fieldName: 'fb' }]);
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);
    const da = await daByField(rebuilt);
    expect(da.get('fa')).toBe('/F$& 10 Tf 0 g');
    expect(da.get('fb')).toBe('/F$&_1 10 Tf 0 g');
  });

  it('same-named fonts differing in /Encoding are NOT deduplicated (review #3)', async () => {
    const a = await withDrFonts([
      { key: 'Helv', base: 'Helvetica', encoding: 'WinAnsiEncoding', fieldName: 'fa' },
    ]);
    const b = await withDrFonts([
      { key: 'Helv', base: 'Helvetica', encoding: 'MacRomanEncoding', fieldName: 'fb' },
    ]);
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);
    const dr = await drBaseFonts(rebuilt);
    expect([...dr.keys()].sort()).toEqual(['Helv', 'Helv_1']);
    const da = await daByField(rebuilt);
    expect(da.get('fa')).toBe('/Helv 10 Tf 0 g');
    expect(da.get('fb')).toBe('/Helv_1 10 Tf 0 g');
  });

  it('embedded fonts (a /FontDescriptor) never count as equivalent (review #3)', async () => {
    const a = await withDrFonts([
      { key: 'Emb', base: 'SameFace', embedded: true, fieldName: 'fa' },
    ]);
    const b = await withDrFonts([
      { key: 'Emb', base: 'SameFace', embedded: true, fieldName: 'fb' },
    ]);
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);
    const dr = await drBaseFonts(rebuilt);
    expect([...dr.keys()].sort()).toEqual(['Emb', 'Emb_1']);
  });

  // Non-simple subtypes hide their rendering data where a top-level check
  // can't see it (review round 2): Type0/CID fonts keep /FontDescriptor
  // nested under /DescendantFonts; Type3 fonts have no descriptor at all —
  // their rendering IS their /CharProcs. The allow-list must refuse both.
  async function withRawDrFont(
    fieldName: string,
    makeFont: (doc: PDFDocument) => PDFRef,
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const form = doc.getForm();
    const f = form.createTextField(fieldName);
    f.setText('x');
    f.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    acro.set(
      PDFName.of('DR'),
      doc.context.obj({ Font: { C0: makeFont(doc) } }),
    );
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    fields.lookup(0, PDFDict).set(PDFName.of('DA'), PDFHexString.fromText('/C0 10 Tf 0 g'));
    return doc.save({ updateFieldAppearances: false });
  }

  it('composite (Type0) fonts never count as equivalent — descriptor hides in DescendantFonts (review round 2)', async () => {
    const type0 = (marker: string) => (doc: PDFDocument) => {
      const descriptor = doc.context.register(
        doc.context.obj({ Type: 'FontDescriptor', FontName: marker }),
      );
      const descendant = doc.context.register(
        doc.context.obj({
          Type: 'Font',
          Subtype: 'CIDFontType2',
          BaseFont: 'SameCJK',
          FontDescriptor: descriptor,
        }),
      );
      return doc.context.register(
        doc.context.obj({
          Type: 'Font',
          Subtype: 'Type0',
          BaseFont: 'SameCJK',
          Encoding: 'Identity-H',
          DescendantFonts: [descendant],
        }),
      );
    };
    const a = await withRawDrFont('fa', type0('FaceA'));
    const b = await withRawDrFont('fb', type0('FaceB'));
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);
    const dr = await drBaseFonts(rebuilt);
    expect([...dr.keys()].sort()).toEqual(['C0', 'C0_1']);
    const da = await daByField(rebuilt);
    expect(da.get('fb')).toBe('/C0_1 10 Tf 0 g');
  });

  it('Type3 fonts never count as equivalent — rendering lives in /CharProcs (review round 2)', async () => {
    const type3 = (proc: string) => (doc: PDFDocument) =>
      doc.context.register(
        doc.context.obj({
          Type: 'Font',
          Subtype: 'Type3',
          BaseFont: 'SameT3',
          Encoding: 'WinAnsiEncoding',
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          CharProcs: { a: doc.context.register(doc.context.stream(proc)) },
        }),
      );
    const a = await withRawDrFont('fa', type3('0 0 m 10 10 l S'));
    const b = await withRawDrFont('fb', type3('0 10 m 10 0 l S'));
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);
    const dr = await drBaseFonts(rebuilt);
    expect([...dr.keys()].sort()).toEqual(['C0', 'C0_1']);
  });

  it('pushes a later source\'s differing AcroForm-level /DA down onto its fields', async () => {
    async function withAcroDa(fieldName: string, da: string): Promise<Uint8Array> {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 800]);
      const form = doc.getForm();
      const f = form.createTextField(fieldName);
      f.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
      const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
      acro.set(PDFName.of('DA'), PDFHexString.fromText(da));
      // Strip the field's own /DA so it genuinely inherits the AcroForm one.
      const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
      fields.lookup(0, PDFDict).delete(PDFName.of('DA'));
      return doc.save();
    }
    const a = await withAcroDa('fa', '/Helv 12 Tf 0 g');
    const b = await withAcroDa('fb', '/Helv 8 Tf 0.5 g');
    const rebuilt = await buildPdf([...pagesOf(a, 'a', [0]), ...pagesOf(b, 'b', [0])]);

    const acro = (await acroFormDictOf(rebuilt))!;
    expect((acro.get(PDFName.of('DA')) as PDFHexString).decodeText()).toBe('/Helv 12 Tf 0 g');
    const doc = await PDFDocument.load(rebuilt, { ignoreEncryption: true });
    const byName = new Map(doc.getForm().getFields().map((f) => [f.getName(), f]));
    expect(byName.get('fa')!.acroField.dict.get(PDFName.of('DA'))).toBeUndefined();
    const fbDa = byName.get('fb')!.acroField.dict.get(PDFName.of('DA')) as PDFHexString;
    expect(fbDa.decodeText()).toBe('/Helv 8 Tf 0.5 g');
  });
});

describe('AcroForm flags and boundaries', () => {
  // Minimal hand-assembled PDF: one page, one merged text-field widget, an
  // /XFA entry and /NeedAppearances true on the AcroForm — pdf-lib refuses to
  // WRITE XFA, so raw assembly is the only way to author this fixture.
  function rawFormWithXfaAndNeedAppearances(): Uint8Array {
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [5 0 R] >>',
      '<< /Fields [5 0 R] /NeedAppearances true /XFA (xfa-packet) >>',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (raw-field) /V (raw-value) /Rect [10 10 100 30] /P 3 0 R >>',
    ];
    let body = '%PDF-1.7\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xrefStart = body.length;
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return new TextEncoder().encode(body + xref + trailer);
  }

  it('drops /XFA (pure-AcroForm posture) but carries /NeedAppearances', async () => {
    const rebuilt = await buildPdf(pagesOf(rawFormWithXfaAndNeedAppearances(), 'a', [0]));
    const acro = (await acroFormDictOf(rebuilt))!;
    expect(acro.get(PDFName.of('XFA'))).toBeUndefined();
    expect(acro.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
    const m = await fieldMap(rebuilt);
    expect(m.get('raw-field')).toMatchObject({ type: 'text', value: 'raw-value' });
  });

  it('recomputes /SigFlags bit 1 from kept signature fields', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.getForm().createTextField('t').addToPage(page, { x: 10, y: 100, width: 100, height: 20 });
    // Low-level empty signature field (pdf-lib has no high-level create).
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    const sig = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: [10, 10, 110, 40],
    }) as PDFDict;
    sig.set(PDFName.of('T'), PDFHexString.fromText('sig1'));
    const sigRef = doc.context.register(sig);
    sig.set(PDFName.of('P'), page.ref);
    fields.push(sigRef);
    page.node.lookup(PDFName.of('Annots'), PDFArray).push(sigRef);
    const src = await doc.save();

    const rebuilt = await buildPdf(pagesOf(src, 'a', [0]));
    const acroOut = (await acroFormDictOf(rebuilt))!;
    expect((acroOut.get(PDFName.of('SigFlags')) as PDFNumber).asNumber()).toBe(1);

    // A form with no signature field gets no /SigFlags at all.
    const plain = await buildPdf(pagesOf(await makePlainForm(), 'a', [0]));
    const acroPlain = (await acroFormDictOf(plain))!;
    expect(acroPlain.get(PDFName.of('SigFlags'))).toBeUndefined();
  });

  async function makePlainForm(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.getForm().createTextField('t').addToPage(page, { x: 10, y: 100, width: 100, height: 20 });
    return doc.save();
  }

  it('leaves orphan widgets orphaned (never resurrects unregistered fields)', async () => {
    // A widget in /Annots that is NOT under /AcroForm /Fields renders as
    // pixels but is not a field; the rebuild must not invent one from it.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.getForm().createTextField('real').addToPage(page, { x: 10, y: 100, width: 100, height: 20 });
    const orphan = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Tx',
      Rect: [10, 10, 110, 40],
    }) as PDFDict;
    orphan.set(PDFName.of('T'), PDFHexString.fromText('orphan'));
    page.node.lookup(PDFName.of('Annots'), PDFArray).push(doc.context.register(orphan));
    const src = await doc.save();

    const rebuilt = await buildPdf(pagesOf(src, 'a', [0]));
    const m = await fieldMap(rebuilt);
    expect(m.has('real')).toBe(true);
    expect(m.has('orphan')).toBe(false);
  });
});
