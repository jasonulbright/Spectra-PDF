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
  saveActiveAs,
  closeAllFiles,
  getWorkspacePageIds,
  selectCanvasPages,
  rotateSelectedCanvasPages,
  commitPendingEdits,
  setCanvasFormValue,
  pendingFormValueCount,
  applyCanvasFormValues,
  formWidgetCount,
  placeNewField,
  createPlacedField,
  signCanvasField,
} from '../support/harness.js';

const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');

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
  const color = form.createRadioGroup('color');
  color.addOptionToPage('red', page, { x: 50, y: 200, width: 16, height: 16 });
  color.addOptionToPage('blue', page, { x: 90, y: 200, width: 16, height: 16 });
  writeFileSync(path, await doc.save());
}

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

describe('on-canvas form filling (2n.4b)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-canvas-forms-'));
    source = resolve(tmp, 'form.pdf');
    await makeFormFixture(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('fills fields on the canvas and bakes them through the real fill path', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');

    // The async forms read must land before values are accepted; the harness
    // setter polls, but assert the widget read too (geometry projected).
    expect(await setCanvasFormValue(source, 'full_name', 'Canvas Fill')).toBe(true);
    expect(await formWidgetCount(source)).toBe(4); // text + checkbox + 2 radio widgets
    expect(await setCanvasFormValue(source, 'subscribe', true)).toBe(true);
    expect(await setCanvasFormValue(source, 'color', 'blue')).toBe(true);
    // Unknown fields are refused, mirroring what the overlay controls allow.
    expect(await setCanvasFormValue(source, 'no-such-field', 'x')).toBe(false);
    expect(await pendingFormValueCount()).toBe(3);

    await applyCanvasFormValues();
    expect(await pendingFormValueCount()).toBe(0);

    const dest = resolve(tmp, 'filled.pdf');
    await saveActiveAs(dest);
    const vals = await fieldValues(dest);
    expect(vals.get('full_name')).toBe('Canvas Fill');
    expect(vals.get('subscribe')).not.toBe('Off');
    expect(vals.get('subscribe')).toBeDefined();
  });

  it('pending values survive a page-edit commit (name-keyed, not positional)', async () => {
    // Typed-but-unapplied values must NOT be dropped by an unrelated page
    // edit committing — field names are stable across the rebuild (and the
    // fields themselves survive it per 2n.4a).
    expect(await setCanvasFormValue(source, 'full_name', 'Survives Commit')).toBe(true);
    expect(await pendingFormValueCount()).toBe(1);

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

    // The buffer changed identity (rebuild) — the pending value must still
    // be there, validated against the re-read fields.
    expect(await pendingFormValueCount()).toBe(1);
    await applyCanvasFormValues();

    const dest = resolve(tmp, 'rotated-filled.pdf');
    await saveActiveAs(dest);
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(dest)),
      isEvalSupported: false,
    }).promise;
    expect((await pdf.getPage(1)).rotate).toBe(90);
    await pdf.loadingTask.destroy();
    const vals = await fieldValues(dest);
    expect(vals.get('full_name')).toBe('Survives Commit');
  });

  it('creates a field on the canvas that is immediately fillable (2n.4c)', async () => {
    // The prior test left the page committed at /Rotate 90, so this also
    // exercises placement conversion on a baked-rotated page.
    await placeNewField({ x: 0.1, y: 0.55, w: 0.4, h: 0.06 });
    await createPlacedField({ name: 'created_on_canvas', type: 'text' });

    expect(await setCanvasFormValue(source, 'created_on_canvas', 'born on canvas')).toBe(true);
    await applyCanvasFormValues();

    const dest = resolve(tmp, 'created-filled.pdf');
    await saveActiveAs(dest);
    const vals = await fieldValues(dest);
    expect(vals.get('created_on_canvas')).toBe('born on canvas');
  });

  it('refuses a duplicate field name through the real validation', async () => {
    await placeNewField({ x: 0.1, y: 0.7, w: 0.3, h: 0.06 });
    let message = '';
    try {
      await createPlacedField({ name: 'full_name', type: 'text' });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('already exists');
  });

  it('creates an empty signature field, then signs INTO it (2n.4c + 2n.4d)', async () => {
    await placeNewField({ x: 0.55, y: 0.75, w: 0.35, h: 0.1 });
    await createPlacedField({ name: 'approval', type: 'signature' });

    const signedOut = resolve(tmp, 'field-signed.pdf');
    const summary = await signCanvasField({
      fieldName: 'approval',
      pfxPath: TEST_PFX,
      password: 'testpw',
      output: signedOut,
      reason: 'Field-fill e2e',
    });
    expect(summary.valid).toBe(true);
    expect(summary.intact).toBe(true);
    expect(summary.covers_whole_document).toBe(true);
    expect(existsSync(signedOut)).toBe(true);

    // Independent check: the signature landed IN the created field (its /V
    // is populated; no second signature field was appended).
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(signedOut)), {
      ignoreEncryption: true,
    });
    const { PDFName, PDFDict, PDFArray } = await import('pdf-lib');
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    let sigFields = 0;
    let signedName = '';
    for (let i = 0; i < fields.size(); i++) {
      const f = fields.lookup(i, PDFDict);
      if (f.get(PDFName.of('FT')) === PDFName.of('Sig')) {
        sigFields++;
        if (f.get(PDFName.of('V')) !== undefined) {
          const t = f.get(PDFName.of('T'));
          signedName = t ? String(t) : '';
        }
      }
    }
    expect(sigFields).toBe(1);
    expect(signedName).toContain('approval');
  });

  it('refuses signing a field while page edits are pending (rename hazard)', async () => {
    // Leave a page edit uncommitted, then try to sign — the flow must refuse
    // (a gate-commit could rename fields out from under a name-only target).
    const ids = await getWorkspacePageIds();
    await selectCanvasPages([ids[0]]);
    await rotateSelectedCanvasPages(90);
    let message = '';
    try {
      await signCanvasField({
        fieldName: 'approval',
        pfxPath: TEST_PFX,
        password: 'testpw',
        output: resolve(tmp, 'should-not-exist.pdf'),
      });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('pending page changes');
    expect(existsSync(resolve(tmp, 'should-not-exist.pdf'))).toBe(false);
    await commitPendingEdits(); // leave the workspace clean for later specs
  });
});
