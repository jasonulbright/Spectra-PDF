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
} from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
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
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
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
