// Field creation loads the user's document, edits it in place and saves it.
// The saved file holds only objects its trailer reaches: nothing the loaded
// file held outside that graph, and nothing the edit left unlinked.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { addFormField, addFormFields } from '../src/renderer/lib/form-authoring';
import type { NewFieldSpec } from '../src/renderer/lib/form-authoring';
import { buildBlankPagePdf } from '../src/renderer/lib/blank-page';
import { expectSound, held, latin1, qpdfReading, shown } from './support/saved-pdf';
import { testPython } from './support/python';

const N = PDFName.of;
const TEXT_FIELD: NewFieldSpec = { name: 'added', type: 'text', pageIndex: 0, rect: [20, 100, 140, 120] };

const fieldNames = async (bytes: Uint8Array): Promise<string[]> =>
  (await PDFDocument.load(bytes)).getForm().getFields().map((field) => field.getName()).sort();

/** One page with a note, saved with a classic cross-reference table. */
async function pageWithNote(text: string): Promise<{ bytes: Uint8Array; page: number; note: number }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const note = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
  note.set(N('Contents'), PDFString.of(text));
  const noteRef = doc.context.register(note);
  page.node.set(N('Annots'), doc.context.obj([noteRef]));
  return { bytes: await doc.save({ useObjectStreams: false }), page: page.ref.objectNumber, note: noteRef.objectNumber };
}

/** `base` with one appended revision: each of `objects` rewritten and each
 *  of `freed` marked free, as an incremental save by another writer leaves
 *  the file. */
function appendRevision(base: Uint8Array, objects: [number, string][], freed: number[]): Uint8Array {
  const text = latin1(base);
  const previous = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]);
  const size = /\/Size (\d+)/.exec(text)![1];
  const root = /\/Root (\d+ \d+ R)/.exec(text)![1];
  let out = text.endsWith('\n') ? text : `${text}\n`;
  const rows: string[] = [`0 1\n${String(freed[0] ?? 0).padStart(10, '0')} 65535 f \n`];
  for (const [number, body] of objects) {
    rows.push(`${number} 1\n${String(out.length).padStart(10, '0')} 00000 n \n`);
    out += `${number} 0 obj\n${body}\nendobj\n`;
  }
  freed.forEach((number, index) => {
    rows.push(`${number} 1\n${String(freed[index + 1] ?? 0).padStart(10, '0')} 00001 f \n`);
  });
  const xref = out.length;
  out += `xref\n${rows.join('')}trailer\n<< /Size ${size} /Root ${root} /Prev ${previous} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** `bytes` rewritten by qpdf through `save` keyword arguments. */
function qpdfSaved(bytes: Uint8Array, options: string): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), 'spectra-form-residue-'));
  try {
    const source = join(directory, 'in.pdf'), target = join(directory, 'out.pdf');
    writeFileSync(source, bytes);
    execFileSync(testPython(), ['-B', '-c',
      `import sys, pikepdf\npdf = pikepdf.open(sys.argv[1])\npdf.save(sys.argv[2], ${options})`, source, target],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return new Uint8Array(readFileSync(target));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('creating a field writes only the objects the document reaches', () => {
  it('a note that a later revision of the input freed is not written as a live object', async () => {
    const { bytes, page, note } = await pageWithNote('FREEDNOTE');
    const loaded = await PDFDocument.load(bytes);
    loaded.getPage(0).node.set(N('Annots'), loaded.context.obj([]));
    const input = appendRevision(bytes, [[page, loaded.getPage(0).node.toString()]], [note]);
    // The input: no reader lists the note, and its bytes still hold the text.
    expect(await shown(input)).toEqual([]);
    expect(qpdfReading(input, ['FREEDNOTE'])).toMatchObject({ problems: [], found: [] });
    expect(latin1(input)).toContain('FREEDNOTE');

    const out = await addFormField(input, TEXT_FIELD);
    await expectSound(out, ['FREEDNOTE']);
    expect(await fieldNames(out)).toEqual(['added']);
    expect(await shown(out)).toMatchObject([{ subtype: 'Widget' }]);
  });

  it('a linearized input loses its linearization dictionary and hint stream', async () => {
    const { bytes } = await pageWithNote('KEPTNOTE');
    const input = qpdfSaved(bytes, 'linearize=True');
    expect(await held(input, ['Linearized'])).toEqual(['Linearized']);

    const out = await addFormField(input, TEXT_FIELD);
    await expectSound(out);
    expect(await held(out, ['Linearized'])).toEqual([]);
    expect(await held(out, ['KEPTNOTE'])).toEqual(['KEPTNOTE']);
    expect((await shown(out)).map((a) => a.subtype).sort()).toEqual(['Text', 'Widget']);
  });

  it('an input that keeps its objects in object streams keeps every reachable object', async () => {
    const { bytes } = await pageWithNote('KEPTNOTE');
    const input = qpdfSaved(bytes, 'object_stream_mode=pikepdf.ObjectStreamMode.generate');
    expect(latin1(input)).toContain('/ObjStm');

    const out = await addFormField(input, TEXT_FIELD);
    await expectSound(out);
    expect((await shown(out)).map((a) => `${a.subtype}:${a.text}`).sort()).toEqual(['Text:KEPTNOTE', 'Widget:']);
  });

  it('the appearances the save redraws leave no replaced stream behind', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 600]);
    const out = await addFormFields(await doc.save(), [
      { name: 'lines', type: 'text', pageIndex: 0, rect: [20, 100, 140, 160], multiline: true, maxLength: 40, defaultValue: 'DEFAULTTEXT',
        format: { kind: 'number', decimals: 2, sepStyle: 0, negStyle: 0, currency: '', currencyPrepend: true } },
      { name: 'rows', type: 'optionlist', pageIndex: 0, rect: [20, 200, 140, 260], options: ['Да', 'plain'] },
      { name: 'pick', type: 'dropdown', pageIndex: 0, rect: [20, 300, 140, 320], options: ['one', 'two'] },
      { name: 'tick', type: 'checkbox', pageIndex: 0, rect: [20, 340, 34, 354] },
      { name: 'choice', type: 'radio', pageIndex: 0, rect: [20, 380, 140, 400], options: ['a', 'b'] },
      { name: 'sign', type: 'signature', pageIndex: 0, rect: [20, 420, 140, 460] },
    ]);
    const reading = await expectSound(out);
    expect(reading.used.fonts).toBeGreaterThan(0);
    expect(await fieldNames(out)).toEqual(['choice', 'lines', 'pick', 'rows', 'sign', 'tick']);
    // The authored script and default value are part of the field.
    expect(await held(out, ['AFNumber_Format', 'DEFAULTTEXT'])).toEqual(['AFNumber_Format', 'DEFAULTTEXT']);
  });
});

describe('creating a field keeps what the loaded document reaches', () => {
  it('a script and a default value an existing field holds by reference', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const field = doc.getForm().createTextField('existing');
    field.addToPage(page, { x: 20, y: 500, width: 120, height: 20 });
    const ctx = doc.context;
    const action = ctx.obj({ S: 'JavaScript' });
    action.set(N('JS'), ctx.register(PDFString.of('KEPTSCRIPT();')));
    field.acroField.dict.set(N('AA'), ctx.obj({ F: ctx.register(action) }));
    field.acroField.dict.set(N('DV'), ctx.register(PDFHexString.fromText('KEPTDEFAULT')));
    doc.setTitle('KEPTTITLE');

    const out = await addFormField(await doc.save(), TEXT_FIELD);
    await expectSound(out);
    expect(await held(out, ['KEPTSCRIPT', 'KEPTDEFAULT', 'KEPTTITLE'])).toEqual(['KEPTSCRIPT', 'KEPTDEFAULT', 'KEPTTITLE']);
    expect(await fieldNames(out)).toEqual(['added', 'existing']);
    expect((await PDFDocument.load(out)).getTitle()).toBe('KEPTTITLE');
  });

  it('a filled signature field keeps its signature dictionary', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const ctx = doc.context;
    const signature = ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 10, 20, 30] });
    signature.set(N('Contents'), PDFHexString.of('AABBCCDD'));
    signature.set(N('Reason'), PDFString.of('KEPTREASON'));
    const widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [20, 500, 140, 540], F: 4, P: page.ref, V: ctx.register(signature) });
    widget.set(N('T'), PDFString.of('signed'));
    const widgetRef = ctx.register(widget);
    page.node.set(N('Annots'), ctx.obj([widgetRef]));
    doc.catalog.set(N('AcroForm'), ctx.obj({ Fields: [widgetRef], SigFlags: 3 }));

    const out = await addFormField(await doc.save(), TEXT_FIELD);
    await expectSound(out);
    const saved = await PDFDocument.load(out);
    const fields = saved.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('Fields'), PDFArray);
    const kept = fields.asArray().map((ref) => saved.context.lookup(ref, PDFDict)).find((dict) => dict.has(N('V')))!;
    const value = kept.lookup(N('V'), PDFDict);
    expect(String(value.get(N('Contents')))).toBe('<AABBCCDD>');
    expect(String(value.get(N('ByteRange')))).toBe('[ 0 10 20 30 ]');
    expect(await held(out, ['KEPTREASON'])).toEqual(['KEPTREASON']);
  });
});

describe('a blank page file', () => {
  it('holds only objects its trailer reaches', async () => {
    await expectSound(await buildBlankPagePdf(200, 300));
  });
});
