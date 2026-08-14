import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFString,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  saveActiveAs,
  closeAllFiles,
  setCanvasFormValue,
  canvasFormShownValue,
  canvasFormScriptsNotRun,
  applyCanvasFormValues,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const SUM = 'AFSimple_Calculate("SUM", "Item1,Item2");';
const MONEY = 'AFNumber_Format(2, 0, 0, 0, "", true);';
const PERCENT = 'AFPercent_Format(1, 0);';
const RANGE = 'AFRange_Validate(true, 0, true, 100);';
const CUSTOM = "this.getField('Item1').value = 'x';";

/** A form authored with the STOCK scripts the ecosystem writes: a summed
 * Total that formats as money, a percent field that validates its range, and
 * one field carrying a script this app does not run. Written with pdf-lib
 * directly because authoring /AA and /CO is a later feature set — and because
 * every form this row serves was authored somewhere else anyway. */
async function makeCalcFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  const named = new Map<string, ReturnType<typeof form.createTextField>>();
  const boxes: [string, number][] = [
    ['Item1', 340],
    ['Item2', 300],
    ['Total', 250],
    ['Rate', 200],
    ['Custom', 150],
  ];
  for (const [name, y] of boxes) {
    const field = form.createTextField(name);
    field.addToPage(page, { x: 50, y, width: 200, height: 22 });
    named.set(name, field);
  }
  // A calculated Total is routinely read-only: the user may not type there,
  // but the document may still compute there.
  named.get('Total')!.enableReadOnly();

  const context = doc.context;
  const script = (js: string): PDFDict =>
    context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of(js) });
  const attach = (name: string, actions: Record<string, string>): void => {
    const dict = named.get(name)!.acroField.dict;
    const aa = context.obj({});
    for (const [trigger, js] of Object.entries(actions)) {
      aa.set(PDFName.of(trigger), context.register(script(js)));
    }
    dict.set(PDFName.of('AA'), aa);
  };
  attach('Total', { C: SUM, F: MONEY });
  attach('Rate', { F: PERCENT, V: RANGE });
  attach('Custom', { C: CUSTOM });

  const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const co = PDFArray.withContext(context);
  co.push(named.get('Custom')!.acroField.ref);
  co.push(named.get('Total')!.acroField.ref);
  acro.set(PDFName.of('CO'), co);

  writeFileSync(path, await doc.save());
}

interface FieldRead {
  value: unknown;
  /** The field's own `/AA` scripts, by pdf.js trigger name. */
  actions: Record<string, string[]>;
}

async function readFields(path: string): Promise<Map<string, FieldRead>> {
  // A fresh read per consumer: pdf.js TRANSFERS the array it is handed, so a
  // buffer shared with anything else comes back detached.
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as {
    fieldName?: string;
    fieldValue?: unknown;
    actions?: Record<string, string[]>;
  }[];
  await pdf.loadingTask.destroy();
  const map = new Map<string, FieldRead>();
  for (const a of annots) {
    if (!a.fieldName) continue;
    map.set(a.fieldName, { value: a.fieldValue, actions: a.actions ?? {} });
  }
  return map;
}

/** What a field's widget actually DRAWS. The saved file compresses its object
 * streams, so this decodes the appearance rather than scanning raw bytes. */
async function appearanceOf(path: string, name: string): Promise<string> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)));
  const widget = doc.getForm().getTextField(name).acroField.getWidgets()[0];
  const stream = doc.context.lookup(widget.getNormalAppearance());
  const bytes =
    stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : new Uint8Array();
  return Buffer.from(bytes).toString('latin1');
}

describe('a form that calculates', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-form-calc-'));
    source = resolve(tmp, 'invoice.pdf');
    await makeCalcFixture(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('updates a dependent Total on the canvas before anything is saved', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');

    expect(await setCanvasFormValue(source, 'Item1', '10')).toBe(true);
    // The Total is read-only, so it was never typed — it appears because the
    // document's own /CO recalculated it, formatted as the page will draw it.
    expect(await canvasFormShownValue(source, 'Total')).toBe('10.00');

    expect(await setCanvasFormValue(source, 'Item2', '1234.5')).toBe(true);
    expect(await canvasFormShownValue(source, 'Total')).toBe('1,244.50');
  });

  it('refuses to type into the read-only calculated field', async () => {
    expect(await setCanvasFormValue(source, 'Total', '999')).toBe(false);
  });

  it('reports the field whose script this app does not run, by name', async () => {
    expect(await canvasFormScriptsNotRun(source)).toEqual(['Custom']);
  });

  it('saves the raw value in /V and the formatted one in /AP', async () => {
    await applyCanvasFormValues();
    const dest = resolve(tmp, 'filled.pdf');
    await saveActiveAs(dest);

    const fields = await readFields(dest);
    // /V keeps the number the next calculation (and any consumer) needs.
    expect(fields.get('Item1')?.value).toBe('10');
    expect(fields.get('Total')?.value).toBe('1244.5');
    // /AP draws what every other viewer shows.
    expect(await appearanceOf(dest, 'Total')).toContain('(1,244.50) Tj');
  });

  it("leaves the unrecognized script's own bytes untouched while its neighbours computed", async () => {
    const dest = resolve(tmp, 'filled.pdf');
    const fields = await readFields(dest);
    expect(fields.get('Custom')?.actions.Calculate).toEqual([CUSTOM]);
    expect(fields.get('Custom')?.value ?? '').toBe('');
    expect(fields.get('Total')?.value).toBe('1244.5');
  });

  it('formats a percent field and refuses a value outside its declared range', async () => {
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');

    expect(await setCanvasFormValue(source, 'Rate', '0.125')).toBe(true);
    expect(await canvasFormShownValue(source, 'Rate')).toBe('12.5%');

    expect(await setCanvasFormValue(source, 'Rate', '150')).toBe(true);
    let message = '';
    try {
      await applyCanvasFormValues();
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('outside the allowed range');
  });
});
