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
  PDFHexString,
  PDFRawStream,
  PDFRef,
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
  canvasFormDataActions,
  fireCanvasFormAction,
  setFieldDataActions,
  applyCanvasFormValues,
  formWidgetCount,
  getState,
  invokeAppCommand,
  placeNewField,
  createPlacedField,
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

// ── authoring: the placement card writes the stock scripts ────────────────
//
// The whole point of writing the ecosystem's own call shapes is that OTHER
// viewers execute them. So the assertions read the authored `/AA` back through
// pdf.js — a second implementation, not ours — and require the exact bodies,
// then fill the form and require the Total the document itself declares.
describe('a form this app authors', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-form-author-'));
    source = resolve(tmp, 'blank.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([600, 400]);
    writeFileSync(source, await doc.save());
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('authors a summed, money-formatted total through the placement card', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    expect(await invokeAppCommand('tools.panel.prepareform')).toBe(true);

    await placeNewField({ x: 0.1, y: 0.2, w: 0.4, h: 0.06 });
    await createPlacedField({ name: 'Item1', type: 'text' }, { path: source });
    await placeNewField({ x: 0.1, y: 0.35, w: 0.4, h: 0.06 });
    await createPlacedField({ name: 'Item2', type: 'text' }, { path: source });
    await placeNewField({ x: 0.1, y: 0.5, w: 0.4, h: 0.06 });
    await createPlacedField(
      {
        name: 'Total',
        type: 'text',
        actions: {
          format: {
            kind: 'number',
            decimals: 2,
            sepStyle: 0,
            negStyle: 0,
            currency: '',
            currencyPrepend: true,
          },
          calculate: { op: 'SUM', fields: ['Item1', 'Item2'] },
        },
      },
      { path: source },
    );

    const authored = resolve(tmp, 'authored.pdf');
    await saveActiveAs(authored);

    // Read back through pdf.js: what a DIFFERENT implementation sees is what
    // decides whether another viewer computes the same total.
    const fields = await readFields(authored);
    expect(fields.get('Total')?.actions.Calculate).toEqual([
      'AFSimple_Calculate("SUM", new Array("Item1","Item2"));',
    ]);
    expect(fields.get('Total')?.actions.Format).toEqual([
      'AFNumber_Format(2, 0, 0, 0, "", true);',
    ]);
    expect(fields.get('Total')?.actions.Keystroke).toEqual([
      'AFNumber_Keystroke(2, 0, 0, 0, "", true);',
    ]);
    expect(await calculationOrder(authored)).toEqual(['Total']);
  });

  it('computes the authored total when the form is filled', async () => {
    expect(await setCanvasFormValue(source, 'Item1', '10')).toBe(true);
    expect(await setCanvasFormValue(source, 'Item2', '1234.5')).toBe(true);
    expect(await canvasFormShownValue(source, 'Total')).toBe('1,244.50');

    await applyCanvasFormValues();
    const filled = resolve(tmp, 'authored-filled.pdf');
    await saveActiveAs(filled);

    const fields = await readFields(filled);
    expect(fields.get('Total')?.value).toBe('1244.5');
    expect(await appearanceOf(filled, 'Total')).toContain('(1,244.50) Tj');
  });

  it('refuses a calculation that would depend on itself', async () => {
    await placeNewField({ x: 0.1, y: 0.65, w: 0.4, h: 0.06 });
    let message = '';
    try {
      await createPlacedField({
        name: 'Loop',
        type: 'text',
        actions: { calculate: { op: 'SUM', fields: ['Loop'] } },
      });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('depends on itself');
  });
});

// ── the /AA action kinds that are data ────────────────────────────────────
//
// Actions that carry no code are both REPORTED and RUN. What this proves is
// the whole loop, not a unit of it: a document authored with pdf-lib is read
// back through this app's classifier, one action is fired through the SAME
// handler the widget's own gesture calls, and the document is asserted to have
// changed. Submit and import are covered at the engine level instead — both
// open a native file dialog, which no harness can answer without becoming the
// thing under test.
describe('a form whose fields DO things', () => {
  let tmp: string;
  let source: string;

  /** A form carrying every action kind this app performs, plus two it only
   * reports, spread across the trigger sites. */
  async function makeActionFixture(path: string): Promise<void> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    doc.addPage([600, 400]);
    const form = doc.getForm();
    const context = doc.context;

    const name = form.createTextField('Name');
    name.addToPage(page, { x: 50, y: 340, width: 200, height: 22 });
    name.setText('typed');
    const helper = form.createTextField('Helper');
    helper.addToPage(page, { x: 50, y: 300, width: 200, height: 22 });

    const button = form.createTextField('Actions');
    button.addToPage(page, { x: 320, y: 340, width: 120, height: 22 });
    const widget = button.acroField.getWidgets()[0];

    // /GoTo the second page, by an explicit destination array.
    const second = doc.getPage(1).ref;
    widget.dict.set(
      PDFName.of('A'),
      context.register(
        context.obj({
          S: PDFName.of('GoTo'),
          D: (() => {
            const dest = PDFArray.withContext(context);
            dest.push(second);
            dest.push(PDFName.of('Fit'));
            return dest;
          })(),
        }),
      ),
    );
    const aa = context.obj({});
    // /ResetForm scoped to one field, on mouse-up.
    aa.set(
      PDFName.of('U'),
      context.register(
        context.obj({
          S: PDFName.of('ResetForm'),
          Fields: (() => {
            const list = PDFArray.withContext(context);
            list.push(PDFString.of('Name'));
            return list;
          })(),
        }),
      ),
    );
    // /Hide the helper field, on pointer-enter.
    aa.set(
      PDFName.of('E'),
      context.register(
        context.obj({
          S: PDFName.of('Hide'),
          T: PDFString.of('Helper'),
          H: true,
        }),
      ),
    );
    // Two kinds this app reports and never performs.
    aa.set(
      PDFName.of('X'),
      context.register(context.obj({ S: PDFName.of('Named'), N: PDFName.of('NextPage') })),
    );
    aa.set(
      PDFName.of('Fo'),
      context.register(
        context.obj({ S: PDFName.of('GoToR'), F: PDFString.of('elsewhere.pdf') }),
      ),
    );
    widget.dict.set(PDFName.of('AA'), aa);

    writeFileSync(path, await doc.save());
  }

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-form-actions-'));
    source = resolve(tmp, 'actions.pdf');
    await makeActionFixture(source);
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('reports every action the document carries, by trigger', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');

    const actions = await canvasFormDataActions(source, 'Actions');
    expect(actions).not.toBeNull();
    expect(actions!.A).toEqual({ kind: 'goto', page: 1 });
    expect(actions!.U).toEqual({ kind: 'reset', fields: ['Name'], exclude: false });
    expect(actions!.E).toEqual({ kind: 'hide', targets: ['Helper'], hide: true });
    // Reported, never performed — and named rather than dropped.
    expect(actions!.X).toEqual({ kind: 'named', name: 'NextPage' });
    expect(actions!.Fo).toEqual({ kind: 'remote', file: 'elsewhere.pdf' });
  });

  it('goes to the page a go-to names', async () => {
    const before = await getState();
    expect(await fireCanvasFormAction(source, 'Actions', 'A')).toBe(true);
    await browser.waitUntil(
      async () => (await getState()).currentPageId !== before.currentPageId,
      { timeout: 10_000, timeoutMsg: 'the go-to action never landed on another page' },
    );
  });

  it('resets only the fields a reset action names', async () => {
    expect(await setCanvasFormValue(source, 'Helper', 'kept')).toBe(true);
    await applyCanvasFormValues();
    expect(await fireCanvasFormAction(source, 'Actions', 'U')).toBe(true);

    const saved = resolve(tmp, 'after-reset.pdf');
    await saveActiveAs(saved);
    const fields = await readFields(saved);
    // "Name" was in the action's own scope and cleared; "Helper" was not.
    expect(fields.get('Name')?.value ?? '').toBe('');
    expect(fields.get('Helper')?.value).toBe('kept');
  });

  it('hides a field for real — in the document, not only on screen', async () => {
    const before = await formWidgetCount(source);
    expect(await fireCanvasFormAction(source, 'Actions', 'E')).toBe(true);
    await browser.waitUntil(async () => (await formWidgetCount(source)) < before, {
      timeout: 10_000,
      timeoutMsg: 'the hide action never removed the widget from the overlay',
    });

    const saved = resolve(tmp, 'after-hide.pdf');
    await saveActiveAs(saved);
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(saved)));
    const hidden = doc.getForm().getTextField('Helper').acroField.getWidgets()[0];
    const flags = hidden.dict.get(PDFName.of('F'));
    expect(Number(flags?.toString() ?? 0) & 2).toBe(2);
  });

  it('authors an action, and another implementation reads back what it wrote', async () => {
    expect(
      await setFieldDataActions(source, 'Actions', [
        { trigger: 'A', kind: 'uri', uri: 'https://example.invalid/help' },
        { trigger: 'D', kind: 'hide', targets: ['Helper'], hide: false },
      ]),
    ).toBe(true);

    // Read back through THIS app first — the properties editor's own inverse.
    await browser.waitUntil(
      async () => {
        const actions = await canvasFormDataActions(source, 'Actions');
        return actions?.A?.kind === 'uri';
      },
      { timeout: 10_000, timeoutMsg: 'the authored action never came back through the reader' },
    );
    const actions = await canvasFormDataActions(source, 'Actions');
    expect(actions!.A).toEqual({ kind: 'uri', uri: 'https://example.invalid/help' });
    expect(actions!.D).toEqual({ kind: 'hide', targets: ['Helper'], hide: false });
    // The door is TOTAL over the triggers it authors: the reset, the /Named
    // and the remote go-to were on triggers it writes, so they are gone.
    expect(Object.keys(actions!).sort()).toEqual(['A', 'D']);

    // Then through pdf-lib — a different implementation, which is what decides
    // whether another viewer performs what this app authored.
    const authored = resolve(tmp, 'authored-actions.pdf');
    await saveActiveAs(authored);
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(authored)));
    const widget = doc.getForm().getTextField('Actions').acroField.getWidgets()[0];
    const action = doc.context.lookup(widget.dict.get(PDFName.of('A')), PDFDict);
    expect(action.get(PDFName.of('S'))?.toString()).toBe('/URI');
    expect((action.get(PDFName.of('URI')) as PDFString).decodeText()).toBe(
      'https://example.invalid/help',
    );
  });

  it('refuses an action naming a page the document does not have', async () => {
    let message = '';
    try {
      await setFieldDataActions(source, 'Actions', [
        { trigger: 'A', kind: 'goto', page: 99 },
      ]);
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('outside this document');
  });
});

/** The `/CO` the saved document declares, by field name. */
async function calculationOrder(path: string): Promise<string[]> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)));
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const co = acro.lookupMaybe(PDFName.of('CO'), PDFArray);
  const names: string[] = [];
  for (let i = 0; i < (co?.size() ?? 0); i++) {
    const entry = co!.get(i);
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) continue;
    const t = dict.get(PDFName.of('T'));
    if (t instanceof PDFString || t instanceof PDFHexString) names.push(t.decodeText());
  }
  return names;
}
