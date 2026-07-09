import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  getState,
  saveActiveAs,
  setReactInputValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function makeFormFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  const name = form.createTextField('full_name');
  name.addToPage(page, { x: 50, y: 300, width: 250, height: 22 });
  const subscribe = form.createCheckBox('subscribe');
  subscribe.addToPage(page, { x: 50, y: 250, width: 16, height: 16 });
  writeFileSync(path, await doc.save());
}

// Independent read of the baked field values via pdf.js widget annotations.
async function fieldValues(path: string): Promise<Map<string, unknown>> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as {
    fieldName?: string;
    fieldValue?: unknown;
  }[];
  const map = new Map<string, unknown>();
  for (const a of annots) if (a.fieldName) map.set(a.fieldName, a.fieldValue);
  await pdf.loadingTask.destroy();
  return map;
}

describe('forms panel fills AcroForm fields and bakes them into the saved file', () => {
  let tmp: string;
  let source: string;
  let dest: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-forms-'));
    source = resolve(tmp, 'form.pdf');
    dest = resolve(tmp, 'filled.pdf');
    await makeFormFixture(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists the fields, fills them, and the values survive in the saved file', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('forms');

    const nameField = $('[data-testid="form-field-full_name"]');
    await nameField.waitForDisplayed({ timeout: 15_000 });
    // Controlled-input safe set (see setReactInputValue for why not setValue).
    await setReactInputValue('[data-testid="form-field-full_name"]', 'Ada Lovelace');
    await $('[data-testid="form-field-subscribe"]').click();

    await $('[data-testid="forms-apply"]').click();
    // UPDATE_FILE marks the file dirty once the fill round trip lands.
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
      timeout: 20_000,
      timeoutMsg: 'fill never marked the file dirty',
    });

    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    const vals = await fieldValues(dest);
    expect(vals.get('full_name')).toBe('Ada Lovelace');
    // A checked box reports its on-state name (never 'Off').
    expect(vals.get('subscribe')).toBeDefined();
    expect(vals.get('subscribe')).not.toBe('Off');
  });
});
