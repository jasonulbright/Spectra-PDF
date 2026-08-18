// The three Ghostscript-backed conversions, driven through their own buttons.
//
// Each of them writes a NEW file, and the first step of writing one is an
// OS-modal save dialog — which WebDriver cannot answer. So none of the three
// had an end-to-end path at all: every earlier spec that exercised one reached
// past the button into a panel bridge, and the whole span from the click to the
// engine request was covered by nothing. `answerNextSaveDialog` closes that:
// the answer is injected at `dialog.saveFile` itself, so the button's handler,
// the name it proposes, the request it assembles and the report it renders are
// the shipped ones and only the dialog is bypassed.
//
// The grayscale case is the one that needed it most. A widget carrying no
// appearance is one the producer synthesizes a value into and flattens into the
// page, under a widget the field reattach then restores over it — so the flatten
// outlives the value it was drawn from and a later refill leaves the OLD value
// painted for good. The engine side of that is pinned in pytest; what could not
// be driven was the same document going out through this app's own convert
// button and coming back in through this app's own fill.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  getState,
  saveActiveAs,
  answerNextSaveDialog,
  saveDialogPending,
  takenSaveDialogDefault,
  waitForDisplayedSelector,
  setCanvasFormValue,
  applyCanvasFormValues,
  canvasFormShownValue,
  formWidgetCount,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const STATUS = '[data-testid="status-bar"]';
/** The page's own paint, drawn as text so the extraction below has a positive
 * control: "the value is not in the page content" means nothing on a page whose
 * content nothing could read. */
const PAGE_MARKER = 'MARKER LINE';
const FIELD = 'bare';
const FILLED = 'Hello';
const REFILLED = 'Ashgray';

/** A filled text field carrying NO appearance stream — the shape a form
 * generator that leans on `/NeedAppearances` produces, and the one the producer
 * synthesizes a flattened copy of.
 *
 * pdf-lib writes an appearance for every field it adds, so the widget is
 * stripped of it afterwards and the save is told not to put one back. The value
 * and the `/DA` that says how to draw it stay, which is all a regeneration has
 * to work from. */
async function makeAplessFormFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.drawText(PAGE_MARKER, { x: 20, y: 40, size: 12 });
  const form = doc.getForm();
  const field = form.createTextField(FIELD);
  field.setText(FILLED);
  field.addToPage(page, { x: 20, y: 100, width: 260, height: 40 });
  for (const widget of field.acroField.getWidgets()) {
    widget.dict.delete(PDFName.of('AP'));
  }
  writeFileSync(path, await doc.save({ updateFieldAppearances: false }));
}

/** Every widget appearance body in the file, by field name. A field with no
 * `/AP` contributes an empty list, which is what the fixture must start as and
 * what the converted output must NOT come back as. */
async function widgetAppearances(path: string, name: string): Promise<string[]> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const bodies: string[] = [];
  for (const widget of doc.getForm().getField(name).acroField.getWidgets()) {
    const normal = widget.getAppearances()?.normal;
    const streams =
      normal instanceof PDFRawStream
        ? [normal]
        : normal instanceof PDFDict
          ? [...normal.values()].filter((v): v is PDFRawStream => v instanceof PDFRawStream)
          : [];
    for (const stream of streams) {
      bodies.push(
        Array.from(decodePDFRawStream(stream).decode(), (b) => String.fromCharCode(b)).join(''),
      );
    }
  }
  return bodies;
}

/** What the PAGE draws, and what each field holds — the two halves the defect
 * separated. Page text comes from the content stream alone: a widget's own
 * appearance is not page content, so a value found here is a FLATTENED copy. */
async function pageTextAndFields(
  path: string,
): Promise<{ text: string; fields: Map<string, unknown> }> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const page = await pdf.getPage(1);
  const content = (await page.getTextContent()) as { items: { str?: string }[] };
  const text = content.items.map((i) => i.str ?? '').join(' ');
  const fields = new Map<string, unknown>();
  for (const a of (await page.getAnnotations()) as {
    fieldName?: string;
    fieldValue?: unknown;
  }[]) {
    if (a.fieldName) fields.set(a.fieldName, a.fieldValue);
  }
  await pdf.loadingTask.destroy();
  return { text, fields };
}

/** Click a panel's action and wait for its status line to say what happened.
 * The selector is re-asked for on every poll: the panel re-renders as the run
 * flips `busy`, and a handle resolved before that is a handle to a dead node. */
async function runPanelAction(button: string, output: string, done: RegExp): Promise<string> {
  await waitForDisplayedSelector(button, {
    timeoutMsg: `${button} never appeared — the panel did not mount`,
  });
  await answerNextSaveDialog(output);
  await $(button).click();
  let status = '';
  await browser.waitUntil(
    async () => {
      status = (await $(STATUS).isExisting()) ? await $(STATUS).getText() : '';
      return done.test(status);
    },
    {
      timeout: 50_000,
      interval: 250,
      timeoutMsg: `${button} never reported a result (last status: ${status})`,
    },
  );
  return status;
}

describe('grayscale conversion, through the panel that writes it', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-convert-gray-'));
    source = resolve(tmp, 'apless-form.pdf');
    await makeAplessFormFixture(source);
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('converts an AP-less filled field and the value is drawn once, by the widget', async function () {
    this.timeout(240_000);

    // The fixture's own premise. A pdf-lib release that starts writing an
    // appearance through `updateFieldAppearances: false` would make every
    // assertion below pass while testing nothing.
    expect(await widgetAppearances(source, FIELD)).toEqual([]);
    const before = await pageTextAndFields(source);
    expect(before.text).toContain(PAGE_MARKER);
    expect(before.fields.get(FIELD)).toBe(FILLED);

    await closeAllFiles();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('grayscale');

    const out = resolve(tmp, 'gray.pdf');
    const status = await runPanelAction('[data-testid="grayscale-convert"]', out, /KB/);
    expect(status).toContain('KB');

    // The dialog was REACHED, and with the name this action proposes for its
    // own output — the half of the button's handler that runs before the
    // engine ever hears about it.
    expect(await saveDialogPending()).toBe(false);
    expect(await takenSaveDialogDefault()).toBe('apless-form_grayscale.pdf');
    expect(existsSync(out)).toBe(true);

    // One painter, and it is the widget. A flattened copy would read back here
    // as page text — the marker proves the page IS being read.
    const after = await pageTextAndFields(out);
    expect(after.text).toContain(PAGE_MARKER);
    expect(after.text).not.toContain(FILLED);
    expect(after.fields.get(FIELD)).toBe(FILLED);
    const faces = await widgetAppearances(out, FIELD);
    expect(faces.length).toBe(1);
    expect(faces[0]).toContain(`(${FILLED})`);

    // …and the app opens it as the form it still is. The widget read is the
    // async forms pass, so it is waited for rather than sampled once — a zero
    // taken the instant the canvas mounts says nothing about the document.
    await closeAllFiles();
    await openByPaths([out]);
    await setView('canvas');
    await browser.waitUntil(async () => (await formWidgetCount(out)) === 1, {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: 'the converted document never read back as a one-widget form',
    });
  });

  it('a refill after the conversion leaves no stale value behind', async function () {
    this.timeout(180_000);

    // Continues from the converted document the previous case left open on the
    // canvas: refilling is where the flatten used to become permanent, because
    // the `/AP` moved to the new value and the page kept painting the old one.
    const out = resolve(tmp, 'gray.pdf');
    expect(await setCanvasFormValue(out, FIELD, REFILLED)).toBe(true);
    // What the overlay SHOWS is the typed value, which is only an override
    // until it is applied — afterwards the document itself holds it and there
    // is nothing left to override, so the read is taken here and the applied
    // value is proven from the file below.
    expect(await canvasFormShownValue(out, FIELD)).toBe(REFILLED);
    await applyCanvasFormValues();

    const refilled = resolve(tmp, 'gray-refilled.pdf');
    await saveActiveAs(refilled);

    const after = await pageTextAndFields(refilled);
    expect(after.text).toContain(PAGE_MARKER);
    expect(after.text).not.toContain(FILLED);
    expect(after.text).not.toContain(REFILLED);
    expect(after.fields.get(FIELD)).toBe(REFILLED);
    const faces = await widgetAppearances(refilled, FIELD);
    expect(faces.length).toBe(1);
    expect(faces[0]).toContain(`(${REFILLED})`);
    expect(faces[0]).not.toContain(`(${FILLED})`);
  });
});

describe('CMYK conversion, through the panel that writes it', () => {
  // Three plates in. A conversion that flattened them to process would be a
  // destroyed printing job that every mark on the page survives, which is why
  // the panel draws its own report beside the result — and why a report
  // reporting nothing removed is an assertion here rather than an absence.
  const SOURCE = resolve(__dirname, '..', 'fixtures', 'separations-spot.pdf');
  let tmp: string;

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-convert-cmyk-'));
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('converts to CMYK and reports what the conversion cost the document', async function () {
    this.timeout(240_000);
    await closeAllFiles();
    await openByPaths([SOURCE]);
    await setView('operations');
    await setActiveOp('convert_cmyk');

    const out = resolve(tmp, 'cmyk.pdf');
    const status = await runPanelAction('[data-testid="cmyk-convert"]', out, /KB/);
    expect(status).toContain('KB');
    expect(await saveDialogPending()).toBe(false);
    expect(await takenSaveDialogDefault()).toBe('separations-spot_cmyk.pdf');
    expect(existsSync(out)).toBe(true);

    // The report renders, and it renders the verdict this document earns: the
    // spot plates survive the conversion, so nothing was removed. The
    // alterations branch draws instead when a row IS reported (pinned per row
    // in pytest, where a loss can be produced deliberately).
    await waitForDisplayedSelector('[data-testid="standards-alterations"]', {
      timeoutMsg: 'the CMYK conversion reported no alterations section at all',
    });
    const rows = await $$('[data-standards-kind]').getElements();
    const clean = await $('[data-testid="standards-clean"]').isExisting();
    expect(clean || rows.length > 0).toBe(true);
    expect(clean).toBe(true);
    expect(rows.length).toBe(0);

    await closeAllFiles();
    await openByPaths([out]);
    const state = await getState();
    expect(state.activeFile?.pageCount).toBe(1);
  });
});

describe('compression, through the panel that writes it', () => {
  const SOURCE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
  let tmp: string;

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-convert-compress-'));
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('compresses through the button and the result keeps every page', async function () {
    this.timeout(240_000);
    await closeAllFiles();
    await openByPaths([SOURCE]);
    const opened = await getState();
    expect(opened.activeFile?.pageCount).toBe(5);

    await setView('operations');
    await setActiveOp('compress');

    const out = resolve(tmp, 'compressed.pdf');
    const status = await runPanelAction('[data-testid="compress-run"]', out, /reduction/);
    expect(status).toContain('reduction');
    expect(await saveDialogPending()).toBe(false);
    expect(await takenSaveDialogDefault()).toBe('sample_compressed.pdf');
    expect(existsSync(out)).toBe(true);

    await closeAllFiles();
    await openByPaths([out]);
    const state = await getState();
    expect(state.activeFile?.pageCount).toBe(5);
  });
});
