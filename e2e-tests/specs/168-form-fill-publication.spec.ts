import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, closeAllFiles, getState, setView, getWorkspacePageIds,
  setCanvasFormValue, pendingFormValueCount, applyCanvasFormValues, invokeAppCommand,
  signActiveFileInPlace, verifyActiveSignatures, setActiveOp } from '../support/harness.js';

type History = { undo: string[]; redo: string[]; buffer: number[] };
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<History>;
const signer = resolve(__dirname, '../fixtures/test-signer.pfx');

describe('form fill publication', () => {
  let directory: string, source: string, working: string;
  before(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-fill-publication-'));
    source = resolve(directory, 'form.pdf');
    const pdf = await PDFDocument.create(); const page = pdf.addPage([600, 800]);
    const field = pdf.getForm().createTextField('name'); field.setText('Original');
    field.addToPage(page, { x: 50, y: 600, width: 250, height: 24 });
    writeFileSync(source, await pdf.save());
  });
  after(async () => { await closeAllFiles(); rmSync(directory, { recursive: true, force: true }); });
  beforeEach(async () => {
    await waitForHarness(); await closeAllFiles(); await openByPaths([source]); await setView('canvas');
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 1);
    working = (await getState()).activeFile!.workingPath;
  });

  it('fills once and restores exact bytes through undo and redo', async () => {
    const before = readFileSync(working);
    expect(await setCanvasFormValue(source, 'name', 'Changed')).toBe(true);
    await applyCanvasFormValues();
    await browser.waitUntil(async () => await pendingFormValueCount() === 0);
    const filled = readFileSync(working), h = await history();
    expect((await PDFDocument.load(filled)).getForm().getTextField('name').getText()).toBe('Changed');
    expect(h.undo).toHaveLength(1); expect(readFileSync(h.undo[0]).equals(before)).toBe(true);
    expect(Buffer.from(h.buffer).equals(filled)).toBe(true);
    await invokeAppCommand('edit.undo');
    await browser.waitUntil(async () => (await history()).undo.length === 0);
    expect(readFileSync(working).equals(before)).toBe(true);
    await invokeAppCommand('edit.redo');
    await browser.waitUntil(async () => (await history()).undo.length === 1);
    expect(readFileSync(working).equals(filled)).toBe(true);
  });

  it('native refusal preserves bytes, history and pending input for retry', async () => {
    const before = readFileSync(working), prior = await history();
    expect(await setCanvasFormValue(source, 'name', 'Retry')).toBe(true);
    chmodSync(working, 0o444);
    try {
      let failure = '';
      await applyCanvasFormValues().catch(error => { failure = String(error); });
      expect(failure).toMatch(/read.only|denied/i);
      expect(await browser.$('[data-testid="forms-fill-error"]').getText()).toMatch(/read.only|denied/i);
      expect(await pendingFormValueCount()).toBe(1);
      expect(readFileSync(working).equals(before)).toBe(true); expect(await history()).toEqual(prior);
    } finally { chmodSync(working, 0o666); }
    await applyCanvasFormValues();
    await browser.waitUntil(async () => await pendingFormValueCount() === 0);
    expect((await history()).undo).toHaveLength(1);
    expect((await PDFDocument.load(readFileSync(working))).getForm().getTextField('name').getText()).toBe('Retry');
  });

  it('permitted signed fills retain the signed byte prefix', async () => {
    await setView('operations'); await setActiveOp('signatures');
    await signActiveFileInPlace({ pfxPath: signer, password: 'testpw', certify: true, certifyLevel: 'form-fill' });
    await setView('canvas');
    const signed = readFileSync(working), prior = await history();
    expect(await setCanvasFormValue(source, 'name', 'Signed fill')).toBe(true);
    await applyCanvasFormValues();
    await browser.waitUntil(async () => await pendingFormValueCount() === 0);
    const filled = readFileSync(working);
    expect(filled.subarray(0, signed.length).equals(signed)).toBe(true);
    expect((await history()).undo).toHaveLength(prior.undo.length + 1);
    await setView('operations'); await setActiveOp('signatures');
    const verified = await verifyActiveSignatures();
    expect(verified.signatures.every(s => s.policy_ok)).toBe(true);
    expect(verified.signatures.length).toBeGreaterThan(0);
    const text = execFileSync(resolve(__dirname, '../../src-tauri/target/debug/spectrapdf.exe'),
      ['verify-signatures', working], { encoding: 'utf8' });
    const report = JSON.parse(text.slice(text.indexOf('{')));
    expect(report.signatures.every((s: { intact: boolean; valid: boolean }) => s.intact && s.valid)).toBe(true);
  });

  it('a signature-policy refusal does not discard unapplied values', async () => {
    await setView('operations'); await setActiveOp('signatures');
    await signActiveFileInPlace({ pfxPath: signer, password: 'testpw', certify: true, certifyLevel: 'none' });
    await setView('canvas');
    const before = readFileSync(working), prior = await history();
    expect(await setCanvasFormValue(source, 'name', 'Keep me')).toBe(true);
    await browser.execute(() => {
      (window as any).__fillDone = false;
      (window as any).__SPECTRA_TEST__.applyCanvasFormValues().finally(() => { (window as any).__fillDone = true; });
    });
    const notice = await browser.$('[data-testid="notice-ok"]'); await notice.waitForDisplayed({ timeout: 30000 });
    await notice.click();
    await browser.waitUntil(() => browser.execute(() => (window as any).__fillDone === true));
    expect(await pendingFormValueCount()).toBe(1);
    expect(readFileSync(working).equals(before)).toBe(true); expect(await history()).toEqual(prior);
  });
});
