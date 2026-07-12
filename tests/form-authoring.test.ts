// On-canvas form-field creation (2n.4c): the pure authoring lib. Every
// created field is read back through the app's own reader (readFormFields),
// filled through the real fill path where fillable, and cross-checked via
// pdf.js; created fields must also survive the 2n.4a rebuild.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addFormField } from '../src/renderer/lib/form-authoring';
import { readFormFields, fillFormFields } from '../src/renderer/lib/forms';
import { buildPdf } from '../src/renderer/lib/pdfx-build';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function blankPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([600, 800]);
  return doc.save();
}

async function fieldMap(bytes: Uint8Array) {
  const { fields } = await readFormFields(bytes);
  return new Map(fields.map((f) => [f.name, f]));
}

describe('addFormField', () => {
  it('creates a text field on a non-form PDF, fillable end to end', async () => {
    const bytes = await addFormField(await blankPdf(), {
      name: 'notes',
      type: 'text',
      pageIndex: 0,
      rect: [50, 700, 250, 724],
      multiline: true,
    });
    const m = await fieldMap(bytes);
    expect(m.get('notes')).toMatchObject({ type: 'text', multiline: true, editable: true });
    expect(m.get('notes')!.widgets).toHaveLength(1);
    expect(m.get('notes')!.widgets[0]).toMatchObject({ pageIndex: 0 });

    const filled = await fillFormFields(bytes, { notes: 'created then filled' });
    const m2 = await fieldMap(filled);
    expect(m2.get('notes')).toMatchObject({ value: 'created then filled' });

    // Independent reader sees the widget as a real field.
    const pdf = await pdfjs.getDocument({ data: filled.slice(), isEvalSupported: false }).promise;
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as { fieldName?: string; fieldValue?: unknown }[];
    expect(annots.some((a) => a.fieldName === 'notes' && a.fieldValue === 'created then filled')).toBe(true);
    await pdf.loadingTask.destroy();
  });

  it('creates checkbox, dropdown, and optionlist fields', async () => {
    let bytes = await blankPdf();
    bytes = await addFormField(bytes, { name: 'agree', type: 'checkbox', pageIndex: 0, rect: [50, 650, 66, 666] });
    bytes = await addFormField(bytes, {
      name: 'country', type: 'dropdown', pageIndex: 0, rect: [50, 600, 170, 624], options: ['US', 'CA'],
    });
    bytes = await addFormField(bytes, {
      name: 'langs', type: 'optionlist', pageIndex: 0, rect: [50, 500, 170, 560], options: ['EN', 'FR'],
    });
    const m = await fieldMap(bytes);
    expect(m.get('agree')).toMatchObject({ type: 'checkbox', editable: true });
    expect(m.get('country')).toMatchObject({ type: 'dropdown', options: ['US', 'CA'] });
    expect(m.get('langs')).toMatchObject({ type: 'optionlist', options: ['EN', 'FR'] });

    const filled = await fillFormFields(bytes, { agree: true, country: 'CA', langs: ['EN', 'FR'] });
    const m2 = await fieldMap(filled);
    expect(m2.get('agree')!.value).toBe(true);
    expect(m2.get('country')!.value).toBe('CA');
    expect(m2.get('langs')!.value).toEqual(['EN', 'FR']);
  });

  it('lays a radio group out as one widget per option inside the drawn box', async () => {
    const bytes = await addFormField(await blankPdf(), {
      name: 'color', type: 'radio', pageIndex: 0, rect: [100, 600, 220, 624], options: ['red', 'green', 'blue'],
    });
    const m = await fieldMap(bytes);
    expect(m.get('color')).toMatchObject({ type: 'radio', options: ['red', 'green', 'blue'] });
    const widgets = m.get('color')!.widgets;
    expect(widgets).toHaveLength(3);
    expect(widgets.map((w) => w.radioOption)).toEqual(['red', 'green', 'blue']);
    // All cells inside the drawn rect, ordered left to right.
    for (const w of widgets) {
      expect(w.rect[0]).toBeGreaterThanOrEqual(100);
      expect(w.rect[2]).toBeLessThanOrEqual(220);
    }
    expect(widgets[0].rect[0]).toBeLessThan(widgets[1].rect[0]);
    expect(widgets[1].rect[0]).toBeLessThan(widgets[2].rect[0]);

    const filled = await fillFormFields(bytes, { color: 'green' });
    expect((await fieldMap(filled)).get('color')!.value).toBe('green');
  });

  it('creates an EMPTY signature field with SigFlags advertised', async () => {
    const bytes = await addFormField(await blankPdf(), {
      name: 'sig1', type: 'signature', pageIndex: 0, rect: [300, 100, 500, 160],
    });
    const m = await fieldMap(bytes);
    expect(m.get('sig1')).toMatchObject({ type: 'signature', filled: false });
    expect(m.get('sig1')!.widgets[0]).toMatchObject({ pageIndex: 0, rect: [300, 100, 500, 160] });
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const { PDFName, PDFDict, PDFNumber } = await import('pdf-lib');
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    expect((acro.get(PDFName.of('SigFlags')) as InstanceType<typeof PDFNumber>).asNumber()).toBe(1);
  });

  it('places on the requested page of a multi-page file', async () => {
    const bytes = await addFormField(await blankPdf(3), {
      name: 'later', type: 'text', pageIndex: 2, rect: [50, 700, 250, 724],
    });
    const m = await fieldMap(bytes);
    expect(m.get('later')!.widgets[0].pageIndex).toBe(2);
  });

  it('created fields survive the page-tier rebuild (2n.4a interplay)', async () => {
    const bytes = await addFormField(await blankPdf(), {
      name: 'keeper', type: 'text', pageIndex: 0, rect: [50, 700, 250, 724],
    });
    const rebuilt = await buildPdf([{ bytes, sourceKey: 'a', pageIndex: 0, rotation: 90 }]);
    const m = await fieldMap(rebuilt);
    expect(m.get('keeper')).toMatchObject({ type: 'text', editable: true });
  });

  it('fails closed with every problem at once, mutating nothing', async () => {
    const base = await addFormField(await blankPdf(), {
      name: 'taken', type: 'text', pageIndex: 0, rect: [50, 700, 250, 724],
    });
    await expect(
      addFormField(base, {
        name: 'taken', // duplicate
        type: 'radio',
        pageIndex: 9, // out of range
        rect: [10, 10, 10, 30], // empty
        options: [], // choice without options
      }),
    ).rejects.toThrow(/already exists.*|out of range.*/);
    try {
      await addFormField(base, {
        name: 'taken', type: 'radio', pageIndex: 9, rect: [10, 10, 10, 30], options: [],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain('already exists');
      expect(msg).toContain('out of range');
      expect(msg).toContain('rectangle is empty');
      expect(msg).toContain('at least one option');
    }
    // Dotted names refused with a plain message.
    await expect(
      addFormField(base, { name: 'a.b', type: 'text', pageIndex: 0, rect: [0, 0, 10, 10] }),
    ).rejects.toThrow(/cannot contain/);
  });

  it('refuses a name held by a NON-TERMINAL hierarchy parent (review-caught)', async () => {
    // pdf-lib's getFields() is terminal-only and cannot see a pure hierarchy
    // node; the hand-rolled signature path has no pdf-lib duplicate backstop,
    // so before the raw top-level /T check it would have created a same-/T
    // sibling next to the parent — two top-level fields sharing a name, which
    // the spec forbids.
    const { PDFArray, PDFDict, PDFHexString, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const form = doc.getForm();
    // A real child so the parent is a genuine hierarchy node.
    form.createTextField('address.street').addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    const bytes = await doc.save();
    // Confirm the parent is top-level and invisible to getFields' terminal view.
    const reread = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const acro = reread.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const tops = acro.lookup(PDFName.of('Fields'), PDFArray);
    const topT = (tops.lookup(0, PDFDict).get(PDFName.of('T')) as InstanceType<typeof PDFHexString>);
    expect(String(topT.decodeText ? topT.decodeText() : topT)).toBe('address');

    // The signature path (no pdf-lib backstop) must refuse via OUR check…
    await expect(
      addFormField(bytes, { name: 'address', type: 'signature', pageIndex: 0, rect: [10, 10, 110, 50] }),
    ).rejects.toThrow(/A field named "address" already exists/);
    // …and the pdf-lib-authored types refuse through the same message (ours,
    // not pdf-lib's internal FieldAlreadyExistsError).
    await expect(
      addFormField(bytes, { name: 'address', type: 'text', pageIndex: 0, rect: [10, 10, 110, 50] }),
    ).rejects.toThrow(/A field named "address" already exists/);
  });

  it('sees a /T stored as an INDIRECT reference (review-noted theoretical gap)', async () => {
    const { PDFArray, PDFDict, PDFName, PDFString } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.getForm().createTextField('anchor').addToPage(page, { x: 10, y: 100, width: 100, height: 20 });
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    // A field whose /T is a ref to a string — no authoring tool writes this,
    // but the walk must still see the name.
    const tRef = doc.context.register(PDFString.of('indirect-named'));
    const weird = doc.context.obj({ FT: 'Tx' }) as InstanceType<typeof PDFDict>;
    weird.set(PDFName.of('T'), tRef);
    fields.push(doc.context.register(weird));
    const bytes = await doc.save({ updateFieldAppearances: false });

    await expect(
      addFormField(bytes, { name: 'indirect-named', type: 'signature', pageIndex: 0, rect: [10, 10, 110, 50] }),
    ).rejects.toThrow(/A field named "indirect-named" already exists/);
  });
});
