// On-canvas form-field creation: the pure authoring lib. Every
// created field is read back through the app's own reader (readFormFields),
// filled through the real fill path where fillable, and cross-checked via
// pdf.js; created fields must also survive the rebuild.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { FieldSpecError, addFormField, addFormFields } from '../src/renderer/lib/form-authoring';
import { readFormFields, fillFormFields } from './helpers/pdflib-forms';
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

/** A field's widget /AP /N content stream, decoded — with the font resource
 * names appended, so a test can say which face the appearance draws through
 * as well as what it draws. */
async function appearanceOf(bytes: Uint8Array, name: string): Promise<string> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const widget = doc.getForm().getField(name).acroField.getWidgets()[0];
  const normal = widget.getAppearances()?.normal;
  if (!(normal instanceof PDFStream)) throw new Error(`no /AP /N stream for ${name}`);
  const fonts = (normal.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? undefined)
    ?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const named = (fonts?.keys() ?? []).map((k) => k.toString()).join(' ');
  const body = decodePDFRawStream(normal as PDFRawStream).decode();
  return `${Array.from(body, (b) => String.fromCharCode(b)).join('')}\n% fonts: ${named}`;
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
    const pdf = await pdfjs.getDocument({ data: filled.slice() }).promise;
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
    const sigFlags = acro.get(PDFName.of('SigFlags'));
    expect(sigFlags instanceof PDFNumber ? sigFlags.asNumber() : sigFlags).toBe(1);
  });

  it('places on the requested page of a multi-page file', async () => {
    const bytes = await addFormField(await blankPdf(3), {
      name: 'later', type: 'text', pageIndex: 2, rect: [50, 700, 250, 724],
    });
    const m = await fieldMap(bytes);
    expect(m.get('later')!.widgets[0].pageIndex).toBe(2);
  });

  it('created fields survive the page-tier rebuild (interplay)', async () => {
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

  it('refuses a name held by a NON-TERMINAL hierarchy parent (regression)', async () => {
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
    const topT = tops.lookup(0, PDFDict).get(PDFName.of('T'));
    expect(String(topT instanceof PDFHexString ? topT.decodeText() : topT)).toBe('address');

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
    const weird = doc.context.obj({ FT: 'Tx' });
    weird.set(PDFName.of('T'), tRef);
    fields.push(doc.context.register(weird));
    const bytes = await doc.save({ updateFieldAppearances: false });

    await expect(
      addFormField(bytes, { name: 'indirect-named', type: 'signature', pageIndex: 0, rect: [10, 10, 110, 50] }),
    ).rejects.toThrow(/A field named "indirect-named" already exists/);
  });
});

describe('addFormFields', () => {
  it('writes N fields through one load and one save', async () => {
    const bytes = await addFormFields(await blankPdf(2), [
      { name: 'first', type: 'text', pageIndex: 0, rect: [50, 700, 250, 724] },
      { name: 'last', type: 'text', pageIndex: 0, rect: [50, 660, 250, 684] },
      { name: 'agree', type: 'checkbox', pageIndex: 1, rect: [50, 600, 62, 612] },
    ]);
    const m = await fieldMap(bytes);
    expect([...m.keys()].sort()).toEqual(['agree', 'first', 'last']);
    expect(m.get('agree')).toMatchObject({ type: 'checkbox' });
    expect(m.get('agree')!.widgets[0]).toMatchObject({ pageIndex: 1 });
  });

  it('reports every problem in the batch at once, each naming its field', async () => {
    const base = await blankPdf();
    try {
      await addFormFields(base, [
        { name: 'ok', type: 'text', pageIndex: 0, rect: [10, 10, 110, 40] },
        { name: 'bad-rect', type: 'text', pageIndex: 0, rect: [10, 10, 10, 10] },
        { name: 'bad-page', type: 'text', pageIndex: 9, rect: [10, 10, 110, 40] },
      ]);
      throw new Error('expected a refusal');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('bad-rect');
      expect(msg).toContain('rectangle is empty');
      expect(msg).toContain('bad-page');
      expect(msg).toContain('out of range');
      expect(msg).not.toContain('ok:');
    }
  });

  it('refuses an XFA document instead of silently deleting its packets', async () => {
    // pdf-lib deletes /XFA on both getForm() and save(), so this path used to
    // destroy the template, datasets, config and localeSet packets with no
    // notice — while the engine twin refuses at every authoring door.
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const acro = doc.context.obj({
      Fields: doc.context.obj([]),
      XFA: doc.context.obj([
        PDFHexString.fromText('datasets'),
        doc.context.register(doc.context.flateStream('<xfa:data/>')),
      ]),
    }) as PDFDict;
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
    const bytes = await doc.save();
    let caught: unknown;
    try {
      await addFormFields(bytes, [
        { name: 'notes', type: 'text', pageIndex: 0, rect: [10, 10, 110, 40] },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FieldSpecError);
    expect((caught as FieldSpecError).problems.map((p) => p.key)).toEqual(['refusal.field.xfa']);
    // Nothing written: the original bytes still carry the packet.
    const after = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    expect(
      after.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.get(PDFName.of('XFA')),
    ).toBeDefined();
  });

  it('refuses two specs in one batch that would share a name, writing nothing', async () => {
    const base = await blankPdf();
    await expect(
      addFormFields(base, [
        { name: 'dup', type: 'text', pageIndex: 0, rect: [10, 10, 110, 40] },
        { name: 'dup', type: 'text', pageIndex: 0, rect: [10, 50, 110, 80] },
      ]),
    ).rejects.toThrow(/already exists/);
  });

  it('places each radio option at its own rectangle when the spec gives them', async () => {
    const bytes = await addFormFields(await blankPdf(), [
      {
        name: 'contact',
        type: 'radio',
        pageIndex: 0,
        rect: [50, 300, 460, 320],
        options: [
          { label: 'Email', rect: [50, 300, 60, 310] },
          { label: 'Phone', rect: [160, 300, 170, 310] },
          { label: 'Mail', rect: [270, 300, 280, 310] },
        ],
      },
    ]);
    const m = await fieldMap(bytes);
    const widgets = m.get('contact')!.widgets;
    expect(widgets).toHaveLength(3);
    expect(widgets.map((w) => Math.round(w.rect[0]))).toEqual([50, 160, 270]);
    expect(m.get('contact')).toMatchObject({ options: ['Email', 'Phone', 'Mail'] });
  });

  it('keeps the equal-cell layout when options carry no rectangles', async () => {
    const bytes = await addFormFields(await blankPdf(), [
      {
        name: 'pick',
        type: 'radio',
        pageIndex: 0,
        rect: [100, 300, 400, 320],
        options: ['a', 'b'],
      },
    ]);
    const widgets = (await fieldMap(bytes)).get('pick')!.widgets;
    expect(widgets).toHaveLength(2);
    expect(widgets[0].rect[0]).toBeGreaterThanOrEqual(100);
    expect(widgets[1].rect[0]).toBeGreaterThan(widgets[0].rect[0]);
  });

  it('refuses a partial set of option rectangles', async () => {
    await expect(
      addFormFields(await blankPdf(), [
        {
          name: 'half',
          type: 'radio',
          pageIndex: 0,
          rect: [50, 300, 460, 320],
          options: [{ label: 'a', rect: [50, 300, 60, 310] }, { label: 'b' }],
        },
      ]),
    ).rejects.toThrow(/every option carries its own rectangle/);
  });

  it('creates a comb text field with its character count', async () => {
    const bytes = await addFormFields(await blankPdf(), [
      {
        name: 'postcode',
        type: 'text',
        pageIndex: 0,
        rect: [180, 590, 300, 610],
        comb: true,
        maxLength: 6,
      },
    ]);
    const reread = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const field = reread.getForm().getTextField('postcode');
    expect(field.getMaxLength()).toBe(6);
    expect(field.isCombed()).toBe(true);
  });

  it('refuses a comb field with no character count, and a combed multiline field', async () => {
    const base = await blankPdf();
    await expect(
      addFormFields(base, [
        { name: 'a', type: 'text', pageIndex: 0, rect: [10, 10, 110, 40], comb: true },
      ]),
    ).rejects.toThrow(/character count/);
    await expect(
      addFormFields(base, [
        {
          name: 'b',
          type: 'text',
          pageIndex: 0,
          rect: [10, 10, 110, 40],
          comb: true,
          maxLength: 4,
          multiline: true,
        },
      ]),
    ).rejects.toThrow(/one line/);
  });

  // The writing mode. pdf-lib cannot author the CID-keyed font a column
  // needs, so the create carries the request and the engine door binds it —
  // but the combinations no font can express are refused HERE, before
  // anything is written, because the door runs after the field already
  // exists and a refusal there would leave a field that never became a
  // column.
  it('creates a vertical text field, leaving the binding to the engine door', async () => {
    const bytes = await addFormFields(await blankPdf(), [
      {
        name: 'tategaki',
        type: 'text',
        pageIndex: 0,
        rect: [400, 400, 430, 700],
        writingMode: 'vertical',
        script: 'japanese',
      },
    ]);
    // The field is a real, readable, fillable text field: the create path is
    // unchanged by the request it carries.
    const m = await fieldMap(bytes);
    expect(m.get('tategaki')).toMatchObject({ type: 'text', editable: true });
  });

  it('accepts a vertical dropdown and a vertical option list', async () => {
    let bytes = await blankPdf();
    bytes = await addFormFields(bytes, [
      {
        name: 'pick',
        type: 'dropdown',
        pageIndex: 0,
        rect: [400, 400, 430, 700],
        options: ['甲', '乙'],
        writingMode: 'vertical',
        script: 'traditional-chinese',
      },
      {
        // ASCII labels deliberately: an option list lays every label out into
        // its appearance through pdf-lib's standard-font encoder, which
        // refuses anything outside WinAnsi. That limit is the same for a
        // horizontal list and says nothing about the writing mode.
        name: 'many',
        type: 'optionlist',
        pageIndex: 0,
        rect: [340, 400, 370, 700],
        options: ['A', 'B'],
        writingMode: 'vertical',
        script: 'korean',
      },
    ]);
    const m = await fieldMap(bytes);
    expect(m.get('pick')).toMatchObject({ type: 'dropdown' });
    expect(m.get('many')).toMatchObject({ type: 'optionlist' });
  });

  it('refuses a writing mode on a kind that draws a mark', async () => {
    const base = await blankPdf();
    for (const type of ['checkbox', 'radio', 'signature'] as const) {
      await expect(
        addFormFields(base, [
          {
            name: 'm',
            type,
            pageIndex: 0,
            rect: [10, 10, 40, 110],
            ...(type === 'radio' ? { options: ['a', 'b'] } : {}),
            writingMode: 'vertical',
            script: 'japanese',
          },
        ]),
      ).rejects.toThrow(/write vertically/);
    }
    // ONE problem, not two: a kind that cannot write vertically must not also
    // be told its field "writes horizontally", which contradicts what was
    // asked for.
    let caught: unknown;
    try {
      await addFormFields(base, [
        {
          name: 'm',
          type: 'checkbox',
          pageIndex: 0,
          rect: [10, 10, 40, 110],
          writingMode: 'vertical',
          script: 'japanese',
        },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FieldSpecError);
    expect((caught as FieldSpecError).problems.map((p) => p.key)).toEqual([
      'refusal.field.writingKindOnly',
    ]);
  });

  it('refuses a vertical field with no script, and a script with no vertical', async () => {
    const base = await blankPdf();
    await expect(
      addFormFields(base, [
        { name: 'a', type: 'text', pageIndex: 0, rect: [10, 10, 40, 110], writingMode: 'vertical' },
      ]),
    ).rejects.toThrow(/needs the script/);
    await expect(
      addFormFields(base, [
        { name: 'b', type: 'text', pageIndex: 0, rect: [10, 10, 40, 110], script: 'korean' },
      ]),
    ).rejects.toThrow(/writes horizontally/);
  });

  it('refuses a vertical comb field', async () => {
    await expect(
      addFormFields(await blankPdf(), [
        {
          name: 'grid',
          type: 'text',
          pageIndex: 0,
          rect: [10, 10, 40, 110],
          comb: true,
          maxLength: 6,
          writingMode: 'vertical',
          script: 'simplified-chinese',
        },
      ]),
    ).rejects.toThrow(/across the axis a column runs down/);
  });

  // The option-list appearance lays out EVERY label, so the create runs each
  // one through the standard font's WinAnsi encoder — which throws its own
  // internal message from inside pdf-lib's appearance provider, mid-batch,
  // with part of the document already written. The labels used to be refused
  // here to keep that throw off the user; now they CREATE, with the widget's
  // appearance suppressed to the box alone and the engine door authoring the
  // rows. The boundary predicate survives as the door-routing one, so the
  // cases that used to name the refusal now prove the field lands.
  it('creates an option list whose labels leave WinAnsi, drawing the box alone', async () => {
    const base = await blankPdf();
    const cases: [string, string[]][] = [
      ['cjk', ['가나', 'plain']],
      ['cyrillic', ['Да', 'plain']],
      // A code point above the BMP: the routing predicate iterates by CODE
      // POINT exactly as the encoder does, so this is ONE character, not two
      // surrogate halves (U+D83D, U+DE00) — the reading a charCodeAt loop
      // would give, which would land this batch in the throwing provider.
      ['astral', ['a\u{1F600}b']],
      // Inside the BMP, outside WinAnsi, and visually a hyphen: the minus sign
      // is the case a "looks Latin" eyeball test would wave through.
      ['minus', ['− 5']],
    ];
    for (const [label, options] of cases) {
      const bytes = await addFormFields(base, [
        { name: label, type: 'optionlist', pageIndex: 0, rect: [50, 500, 250, 560], options },
      ]);
      const m = await fieldMap(bytes);
      expect(m.get(label), label).toMatchObject({ type: 'optionlist', options });
      // The appearance is the box and nothing else — no text object at all
      // reached the encoder, and the engine door draws the rows next.
      const drawn = await appearanceOf(bytes, label);
      expect(drawn, label).not.toMatch(/BT|Tj|TJ/);
      expect(drawn, label).toMatch(/\bB\b/); // the box is filled and stroked
    }
  });

  it('keeps the pdf-lib appearance for an option list WinAnsi covers', async () => {
    // The byte-identity boundary in the other direction: a covered list is the
    // single pdf-lib write it has always been, rows drawn by its own provider.
    const bytes = await addFormFields(await blankPdf(), [
      {
        name: 'covered',
        type: 'optionlist',
        pageIndex: 0,
        rect: [50, 500, 250, 560],
        options: ['Red', 'Grün', 'Café'],
      },
    ]);
    const drawn = await appearanceOf(bytes, 'covered');
    expect(drawn).toMatch(/Tj/);
    expect(drawn).toContain('/Helvetica');
  });

  it('creates an option list from every label WinAnsi does cover', async () => {
    // Each of these is OUTSIDE ASCII and INSIDE WinAnsi, so a codePoint > 0x7F
    // test would refuse work that pdf-lib draws without complaint.
    const options = ['Café', '“Quoted” ‘x’', 'a—b', '€100', '• item', '™', 'Ærø', 'plain'];
    const bytes = await addFormFields(await blankPdf(), [
      { name: 'covered', type: 'optionlist', pageIndex: 0, rect: [50, 400, 300, 560], options },
    ]);
    const m = await fieldMap(bytes);
    expect(m.get('covered')).toMatchObject({ type: 'optionlist', options });
  });

  it('creates a dropdown and a radio group from the labels an option list refuses', async () => {
    // The refusal must not over-reach. A dropdown's appearance draws only the
    // SELECTED value and a new field has none; a radio option draws a mark.
    // Neither reaches the encoder, so neither is refused.
    let bytes = await blankPdf();
    bytes = await addFormFields(bytes, [
      {
        name: 'country',
        type: 'dropdown',
        pageIndex: 0,
        rect: [50, 600, 250, 624],
        options: ['US', '한국', 'Да'],
      },
      {
        name: 'pick',
        type: 'radio',
        pageIndex: 0,
        rect: [50, 500, 250, 524],
        options: ['가나', '다라'],
      },
    ]);
    const m = await fieldMap(bytes);
    expect(m.get('country')).toMatchObject({ type: 'dropdown', options: ['US', '한국', 'Да'] });
    expect(m.get('pick')).toMatchObject({ type: 'radio' });
  });

  it('creates a list of many unencodable labels without touching the encoder', async () => {
    // A label pasted from another script used to be refused character by
    // character. It creates now; what still must not happen is the standard
    // encoder seeing any of it, which it would do through `save()`'s dirty
    // -field sweep if the box-only draw had not also marked the field clean.
    const bytes = await addFormFields(await blankPdf(), [
      {
        name: 'many',
        type: 'optionlist',
        pageIndex: 0,
        rect: [50, 400, 300, 560],
        options: ['ΑΒΓΔΕ', 'ΖΗΘΙΚΑΒ'],
      },
    ]);
    const m = await fieldMap(bytes);
    expect(m.get('many')).toMatchObject({ type: 'optionlist', options: ['ΑΒΓΔΕ', 'ΖΗΘΙΚΑΒ'] });
    expect(await appearanceOf(bytes, 'many')).not.toMatch(/BT/);
  });

  it('is what the single-field entry point calls', async () => {
    const one = await addFormField(await blankPdf(), {
      name: 'solo',
      type: 'text',
      pageIndex: 0,
      rect: [10, 10, 110, 40],
    });
    const batch = await addFormFields(await blankPdf(), [
      { name: 'solo', type: 'text', pageIndex: 0, rect: [10, 10, 110, 40] },
    ]);
    expect((await fieldMap(one)).get('solo')).toEqual((await fieldMap(batch)).get('solo'));
  });
});
