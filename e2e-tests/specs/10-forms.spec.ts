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
  getWorkspacePageIds,
  selectCanvasPages,
  rotateSelectedCanvasPages,
  commitPendingEdits,
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
async function fieldValues(path: string, pageNumber = 1): Promise<Map<string, unknown>> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const annots = (await (await pdf.getPage(pageNumber)).getAnnotations()) as {
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

  it('page-edit commits preserve the form (2n.4a): rotate → apply → fields intact', async () => {
    // The page-tier commit rebuilds the file from scratch (buildPdf); before
    // the AcroForm carry, that rebuild dropped /AcroForm entirely — ONE
    // committed rotation semantically destroyed every field (still rendered,
    // dead). This drives the REAL commit bridge in the built binary over the
    // already-FILLED working copy, so the values must survive too.
    const rotatedDest = resolve(tmp, 'rotated-form.pdf');
    await setView('canvas');
    let ids: string[] = [];
    await browser.waitUntil(
      async () => {
        ids = await getWorkspacePageIds();
        return ids.length > 0;
      },
      { timeout: 15_000, timeoutMsg: 'workspace indexer never produced pages' },
    );
    await selectCanvasPages([ids[0]]);
    await rotateSelectedCanvasPages(90);
    await commitPendingEdits();
    await saveActiveAs(rotatedDest);

    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(rotatedDest)),
      isEvalSupported: false,
    }).promise;
    const page = await pdf.getPage(1);
    expect(page.rotate).toBe(90); // the rebuild really ran
    await pdf.loadingTask.destroy();

    const vals = await fieldValues(rotatedDest);
    expect(vals.get('full_name')).toBe('Ada Lovelace');
    expect(vals.get('subscribe')).toBeDefined();
    expect(vals.get('subscribe')).not.toBe('Off');
  });

  it('CLI fill (engine path) matches the GUI fill (pdf-lib path) field-for-field (2l)', async () => {
    // Cross-IMPLEMENTATION parity: the same source form filled with the same
    // values via the headless CLI (pikepdf engine + generated appearances)
    // must read back identically — through a third reader (pdf.js) — to the
    // GUI fill asserted above.
    const { execFileSync } = await import('node:child_process');
    const cliOut = resolve(tmp, 'filled-cli.pdf');
    const binary = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'openpdfstudio.exe');
    execFileSync(binary, [
      'forms', source,
      '-o', cliOut,
      '--set', 'full_name=Ada Lovelace',
      '--set', 'subscribe=true',
    ]);
    expect(existsSync(cliOut)).toBe(true);

    const gui = await fieldValues(dest);
    const cli = await fieldValues(cliOut);
    expect(cli.get('full_name')).toBe(gui.get('full_name'));
    expect(cli.get('subscribe')).not.toBe('Off');
    expect(gui.get('subscribe')).not.toBe('Off');
  });

  it('CLI merge preserves both inputs\' form fields (2n.4a, bundled-runtime path)', async () => {
    // Drives the REAL bundled Python runtime through the binary — the path
    // that caught a too-old bundled pikepdf (venv-only testing missed it).
    // Uses the FILLED output from the first test as input 1 so values must
    // survive; input 2 shares a field name to exercise the rename path.
    const { execFileSync } = await import('node:child_process');
    const other = resolve(tmp, 'other-form.pdf');
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const form = doc.getForm();
    const clash = form.createTextField('full_name');
    clash.setText('Grace Hopper');
    clash.addToPage(page, { x: 50, y: 300, width: 250, height: 22 });
    const extra = form.createTextField('department');
    extra.setText('Engineering');
    extra.addToPage(page, { x: 50, y: 250, width: 250, height: 22 });
    writeFileSync(other, await doc.save());

    const mergedOut = resolve(tmp, 'merged.pdf');
    const binary = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'openpdfstudio.exe');
    execFileSync(binary, ['merge', dest, other, '-o', mergedOut]);

    const p1 = await fieldValues(mergedOut, 1);
    expect(p1.get('full_name')).toBe('Ada Lovelace');
    const p2 = await fieldValues(mergedOut, 2);
    // The second file's colliding field was renamed (name+1), value intact.
    expect(p2.get('full_name+1')).toBe('Grace Hopper');
    expect(p2.get('department')).toBe('Engineering');
  });
});
