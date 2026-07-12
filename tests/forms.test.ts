import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFormFields, fillFormFields } from '../src/renderer/lib/forms';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Build a form with one of every supported field kind plus a read-only field.
async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  const name = form.createTextField('applicant.name');
  name.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });

  const notes = form.createTextField('applicant.notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 50, y: 600, width: 200, height: 60 });

  const agree = form.createCheckBox('applicant.agree');
  agree.addToPage(page, { x: 50, y: 560, width: 15, height: 15 });

  const color = form.createRadioGroup('applicant.color');
  color.addOptionToPage('red', page, { x: 50, y: 520, width: 15, height: 15 });
  color.addOptionToPage('blue', page, { x: 100, y: 520, width: 15, height: 15 });

  const country = form.createDropdown('applicant.country');
  country.addOptions(['USA', 'Canada', 'Mexico']);
  country.addToPage(page, { x: 50, y: 480, width: 120, height: 20 });

  const langs = form.createOptionList('applicant.langs');
  langs.setOptions(['EN', 'FR', 'ES']);
  langs.enableMultiselect();
  langs.addToPage(page, { x: 50, y: 400, width: 120, height: 60 });

  const id = form.createTextField('applicant.id');
  id.setText('LOCKED');
  id.enableReadOnly();
  id.addToPage(page, { x: 50, y: 360, width: 120, height: 20 });

  return doc.save();
}

// Independent read of each field's baked /V, straight off the page's widget
// annotations (fieldName -> fieldValue). Dotted field names produce parent
// stubs in getFieldObjects whose `value` is undefined, so the flat widget
// list is the honest cross-check.
async function fieldValuesFromPdfjs(bytes: Uint8Array): Promise<Map<string, unknown>> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as {
    fieldName?: string;
    fieldValue?: unknown;
  }[];
  const map = new Map<string, unknown>();
  for (const a of annots) if (a.fieldName) map.set(a.fieldName, a.fieldValue);
  await pdf.loadingTask.destroy();
  return map;
}

// Whether any interactive form widget survives (for the flatten check).
async function hasFormWidgets(bytes: Uint8Array): Promise<boolean> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as { fieldName?: string }[];
  const any = annots.some((a) => a.fieldName !== undefined);
  await pdf.loadingTask.destroy();
  return any;
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const content = (await page.getTextContent()) as { items: { str?: string }[] };
  const text = content.items.map((it) => it.str ?? '').join(' ');
  await pdf.loadingTask.destroy();
  return text;
}

function byName(fields: Awaited<ReturnType<typeof readFormFields>>['fields']) {
  return new Map(fields.map((f) => [f.name, f]));
}

// A minimal, valid PDF whose AcroForm carries /XFA — hand-assembled with a
// correct byte-offset xref (all-ASCII, so string length == byte length) since
// pdf-lib refuses to write XFA back out.
function rawPdfWithXFA(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    '<< /Fields [] /NeedAppearances true /XFA (xfa-packet) >>',
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

describe('readFormFields', () => {
  it('enumerates every field with its type, value, options, and flags', async () => {
    const { fields, hasXFA } = await readFormFields(await makeFormPdf());
    expect(hasXFA).toBe(false);
    const m = byName(fields);

    expect(m.get('applicant.name')).toMatchObject({ type: 'text', value: '', editable: true });
    expect(m.get('applicant.notes')).toMatchObject({ type: 'text', multiline: true, editable: true });
    expect(m.get('applicant.agree')).toMatchObject({ type: 'checkbox', value: false });
    expect(m.get('applicant.color')).toMatchObject({ type: 'radio', value: '' });
    expect(m.get('applicant.color')!.options).toEqual(['red', 'blue']);
    expect(m.get('applicant.country')).toMatchObject({ type: 'dropdown' });
    expect(m.get('applicant.country')!.options).toEqual(['USA', 'Canada', 'Mexico']);
    expect(m.get('applicant.langs')).toMatchObject({ type: 'optionlist', value: [] });
    expect(m.get('applicant.langs')!.options).toEqual(['EN', 'FR', 'ES']);

    const id = m.get('applicant.id')!;
    expect(id).toMatchObject({ type: 'text', value: 'LOCKED', readOnly: true, editable: false });
  });

  it('returns no fields and no XFA for a plain PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const { fields, hasXFA } = await readFormFields(await doc.save());
    expect(fields).toEqual([]);
    expect(hasXFA).toBe(false);
  });

  it('detects XFA on the read side', async () => {
    // pdf-lib's save() STRIPS /XFA ("does not support reading or writing
    // XFA"), so a round-tripped fixture can't carry it — detection only
    // matters for user-supplied bytes anyway. Hand-build a minimal PDF whose
    // AcroForm has /XFA (byte-offset xref so pdf-lib parses it).
    const { hasXFA } = await readFormFields(rawPdfWithXFA());
    expect(hasXFA).toBe(true);
  });
});

describe('fillFormFields', () => {
  it('fills each field kind and a plain reader reads the values back', async () => {
    const filled = await fillFormFields(await makeFormPdf(), {
      'applicant.name': 'Ada Lovelace',
      'applicant.notes': 'first line\nsecond line',
      'applicant.agree': true,
      'applicant.color': 'blue',
      'applicant.country': 'Canada',
      'applicant.langs': ['EN', 'ES'],
    });

    // Round-trip via our own reader.
    const m = byName((await readFormFields(filled)).fields);
    expect(m.get('applicant.name')!.value).toBe('Ada Lovelace');
    expect(m.get('applicant.notes')!.value).toBe('first line\nsecond line');
    expect(m.get('applicant.agree')!.value).toBe(true);
    expect(m.get('applicant.color')!.value).toBe('blue');
    expect(m.get('applicant.country')!.value).toBe('Canada');
    expect(m.get('applicant.langs')!.value).toEqual(['EN', 'ES']);

    // Non-circular: pdf.js (independent parser) sees the /V values.
    const vals = await fieldValuesFromPdfjs(filled);
    expect(vals.get('applicant.name')).toBe('Ada Lovelace');
    expect(vals.get('applicant.country')).toEqual(['Canada']); // choice values come back as arrays
  });

  it('never writes a read-only field', async () => {
    const filled = await fillFormFields(await makeFormPdf(), { 'applicant.id': 'HACKED' });
    const m = byName((await readFormFields(filled)).fields);
    expect(m.get('applicant.id')!.value).toBe('LOCKED');
  });

  it('ignores an out-of-range option instead of throwing', async () => {
    const filled = await fillFormFields(await makeFormPdf(), { 'applicant.color': 'chartreuse' });
    const m = byName((await readFormFields(filled)).fields);
    expect(m.get('applicant.color')!.value).toBe(''); // unchanged, no throw
  });

  it('flatten removes all fields and bakes the value into page content', async () => {
    const flat = await fillFormFields(
      await makeFormPdf(),
      { 'applicant.name': 'Grace Hopper' },
      { flatten: true },
    );
    // No interactive fields survive a flatten.
    expect((await readFormFields(flat)).fields).toEqual([]);
    expect(await hasFormWidgets(flat)).toBe(false);
    // The value is now real page content (the widget appearance was baked in).
    expect(await pageText(flat)).toContain('Grace Hopper');
  });

  it('surfaces a clear error when appearances cannot be regenerated', async () => {
    // Non-Latin-1 text throws in pdf-lib's WinAnsi appearance generation.
    await expect(
      fillFormFields(await makeFormPdf(), { 'applicant.name': 'ロボット' }),
    ).rejects.toThrow(/appearances/i);
  });
});

describe('readFormFields widget geometry (2n.4b)', () => {
  // Multi-page form with widgets whose page + rect the on-canvas overlay
  // depends on: text on p0, a multi-widget text field on p0+p2, a radio
  // spanning pages (pdf-lib /Opt-indexed on-states), and a low-level
  // signature field pair (empty vs /V-holding).
  async function makeGeometryPdf(): Promise<Uint8Array> {
    const { PDFArray, PDFDict, PDFHexString, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const p0 = doc.addPage([600, 800]);
    doc.addPage([600, 800]);
    const p2 = doc.addPage([600, 800]);
    const form = doc.getForm();

    const title = form.createTextField('title');
    title.addToPage(p0, { x: 50, y: 700, width: 200, height: 20 });

    const span = form.createTextField('span');
    span.addToPage(p0, { x: 10, y: 20, width: 100, height: 30 });
    span.addToPage(p2, { x: 40, y: 60, width: 100, height: 30 });

    const color = form.createRadioGroup('color');
    color.addOptionToPage('red', p0, { x: 50, y: 600, width: 15, height: 15 });
    color.addOptionToPage('blue', p2, { x: 50, y: 600, width: 15, height: 15 });

    // Low-level signature fields: 'sig-empty' (no /V) and 'sig-done' (/V).
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    const addSig = (name: string, withV: boolean, rect: number[]): void => {
      const sig = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        Rect: rect,
      }) as InstanceType<typeof PDFDict>;
      sig.set(PDFName.of('T'), PDFHexString.fromText(name));
      if (withV) sig.set(PDFName.of('V'), doc.context.obj({}));
      const ref = doc.context.register(sig);
      sig.set(PDFName.of('P'), p0.ref);
      fields.push(ref);
      p0.node.lookup(PDFName.of('Annots'), PDFArray).push(ref);
    };
    addSig('sig-empty', false, [300, 100, 450, 140]);
    addSig('sig-done', true, [300, 200, 450, 240]);

    // Widget-less pure-data field.
    const ghost = doc.context.obj({ FT: 'Tx' }) as InstanceType<typeof PDFDict>;
    ghost.set(PDFName.of('T'), PDFHexString.fromText('ghost'));
    fields.push(doc.context.register(ghost));

    // pdf-lib's save-time appearance regeneration treats the widget-less
    // 'ghost' field as its own widget and throws on the missing /Rect.
    return doc.save({ updateFieldAppearances: false });
  }

  it('reports each widget with its page, PDF-space rect, and flags', async () => {
    const m = byName((await readFormFields(await makeGeometryPdf())).fields);
    // pdf-lib pads /Rect by half its default border width, so assert within
    // a point rather than pinning its internals.
    const rectNear = (got: number[], want: number[]): void =>
      want.forEach((v, i) => expect(Math.abs(got[i] - v)).toBeLessThanOrEqual(1));
    const title = m.get('title')!.widgets;
    expect(title).toHaveLength(1);
    expect(title[0]).toMatchObject({ pageIndex: 0, hidden: false });
    rectNear(title[0].rect, [50, 700, 250, 720]);
    const span = m.get('span')!.widgets;
    expect(span).toHaveLength(2);
    expect(span[0].pageIndex).toBe(0);
    rectNear(span[0].rect, [10, 20, 110, 50]);
    expect(span[1].pageIndex).toBe(2);
    rectNear(span[1].rect, [40, 60, 140, 90]);
  });

  it('maps each radio widget to the option it selects (/Opt-indexed on-states)', async () => {
    const m = byName((await readFormFields(await makeGeometryPdf())).fields);
    const widgets = m.get('color')!.widgets;
    expect(widgets).toHaveLength(2);
    expect(widgets[0]).toMatchObject({ pageIndex: 0, radioOption: 'red' });
    expect(widgets[1]).toMatchObject({ pageIndex: 2, radioOption: 'blue' });
  });

  it('flags signature fields as filled only when /V is present', async () => {
    const m = byName((await readFormFields(await makeGeometryPdf())).fields);
    expect(m.get('sig-empty')).toMatchObject({ type: 'signature', filled: false });
    expect(m.get('sig-done')).toMatchObject({ type: 'signature', filled: true });
    expect(m.get('sig-empty')!.widgets).toHaveLength(1);
  });

  it('a widget-less pure-data field reports an empty placement list', async () => {
    const m = byName((await readFormFields(await makeGeometryPdf())).fields);
    expect(m.get('ghost')!.widgets).toEqual([]);
  });
});
