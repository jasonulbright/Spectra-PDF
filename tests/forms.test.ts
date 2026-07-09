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
