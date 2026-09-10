import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { waitForHarness, closeAllFiles, openByPaths, getState, invokeAppCommand, focusTab,
  setView, setActiveOp, setReactInputValue, waitForActiveCanvasPageIds,
  deleteCanvasPagesAndWait } from '../support/harness.js';

const input = '[data-testid="form-field-name"]', apply = '[data-testid="forms-apply"]';
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[] }>;
const form = async (path: string) => (await PDFDocument.load(readFileSync(path))).getForm();
async function panel() { await setView('operations'); await setActiveOp('forms'); }
async function value(text: string) {
  await $(input).waitForDisplayed();
  await browser.waitUntil(async () => await $(input).getValue() === text);
}
async function save(path: string, text: string) {
  await $(apply).waitForEnabled(); await $(apply).click();
  await browser.waitUntil(async () => (await form(path)).getTextField('name').getText() === text);
  await browser.waitUntil(async () => /Filled/.test(await $('[data-testid="status-bar"]').getText()));
  await $(apply).waitForEnabled();
}

describe('Forms-panel draft ownership in the live workspace', () => {
  let a: string, b: string, aw: string;
  beforeEach(async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../docs/audit/form-drafts.local.d-'));
    a = resolve(dir, 'A.pdf'); b = resolve(dir, 'B.pdf');
    for (const [path, label] of [[a, 'Original A'], [b, 'Original B']]) {
      const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]); pdf.addPage([600, 800]);
      const field = pdf.getForm().createTextField('name'); field.setText(label);
      field.addToPage(page, { x: 50, y: 600, width: 250, height: 24 });
      const check = pdf.getForm().createCheckBox('accepted');
      check.addToPage(page, { x: 50, y: 550, width: 20, height: 20 });
      writeFileSync(path, await pdf.save());
    }
    await waitForHarness(); await closeAllFiles(); await openByPaths([a]); await panel(); await value('Original A');
    aw = (await getState()).activeFile!.workingPath;
  });

  it('A-B-A keeps independent values and Flatten choice; each Apply writes only its document', async () => {
    const beforeA = readFileSync(aw); await setReactInputValue(input, 'Only A');
    await $('[data-testid="form-field-accepted"]').click(); await $('[data-testid="forms-flatten"]').click();
    await openByPaths([b]); await value('Original B');
    const bw = (await getState()).activeFile!.workingPath, beforeB = readFileSync(bw);
    expect(await $('[data-testid="forms-flatten"]').isSelected()).toBe(false);
    expect(await $('[data-testid="form-field-accepted"]').isSelected()).toBe(false);
    await setReactInputValue(input, 'Only B'); await focusTab({ doc: a }); await value('Only A');
    expect(await $('[data-testid="forms-flatten"]').isSelected()).toBe(true);
    expect(await $('[data-testid="form-field-accepted"]').isSelected()).toBe(true);
    expect(readFileSync(aw).equals(beforeA)).toBe(true); expect(readFileSync(bw).equals(beforeB)).toBe(true);
    await $('[data-testid="forms-flatten"]').click(); await save(aw, 'Only A');
    expect((await form(aw)).getCheckBox('accepted').isChecked()).toBe(true);
    expect(readFileSync(bw).equals(beforeB)).toBe(true); expect((await history()).undo).toHaveLength(1);
    await focusTab({ doc: b }); await value('Only B'); await save(bw, 'Only B');
    expect((await form(a)).getTextField('name').getText()).toBe('Original A');
    expect((await form(b)).getTextField('name').getText()).toBe('Original B');
  });

  it('Home and panel remount retain input; successful Apply does not replay a consumed draft', async () => {
    await setReactInputValue(input, 'Retained'); await focusTab('home'); await focusTab({ doc: a });
    await setActiveOp('links'); await panel(); await value('Retained'); await save(aw, 'Retained');
    await focusTab('home'); await focusTab({ doc: a }); await panel(); await value('Retained');
    await $(apply).waitForEnabled(); await $(apply).click();
    await browser.waitUntil(async () => /No changes/.test(await $('[data-testid="status-bar"]').getText()));
    expect((await history()).undo).toHaveLength(1);
  });

  it('closing retires unsaved values and options when the original is reopened', async () => {
    await setReactInputValue(input, 'Closed'); await $('[data-testid="forms-flatten"]').click();
    await closeAllFiles(); await openByPaths([a]); await panel(); await value('Original A');
    expect(await $('[data-testid="forms-flatten"]').isSelected()).toBe(false);
    expect((await history()).undo).toHaveLength(0);
  });

  it('native refusal retains input; retry writes once and Undo restores bytes and the clean editor baseline', async () => {
    const before = readFileSync(aw); await setReactInputValue(input, 'Retry'); chmodSync(aw, 0o444);
    try {
      await $(apply).click();
      await browser.waitUntil(async () => /read.only|denied/i.test(await $('[data-testid="status-bar"]').getText()));
      expect(readFileSync(aw).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
      expect(await $(input).getValue()).toBe('Retry');
    } finally { chmodSync(aw, 0o666); }
    await save(aw, 'Retry'); expect((await history()).undo).toHaveLength(1);
    await invokeAppCommand('edit.undo'); await value('Original A'); expect(readFileSync(aw).equals(before)).toBe(true);
  });

  it('page deletion preserves stale input and refuses Apply until explicit discard/reload', async () => {
    const before = readFileSync(aw); await setReactInputValue(input, 'Do not misapply');
    const ids = await waitForActiveCanvasPageIds(); await deleteCanvasPagesAndWait([ids[0]]);
    await $('[data-testid="forms-reload"]').waitForDisplayed();
    expect(await $(apply).isEnabled()).toBe(false); expect(await $(input).isEnabled()).toBe(false);
    expect(await $(input).getValue()).toBe('Do not misapply'); expect(readFileSync(aw).equals(before)).toBe(true);
    await $('[data-testid="forms-reload"]').click(); await $(input).waitForExist({ reverse: true });
    expect((await PDFDocument.load(readFileSync(aw))).getPageCount()).toBe(1);
    expect((await form(aw)).getFields()).toHaveLength(0);
  });

  it('Flatten publishes the typed value and retires the consumed option', async () => {
    await setReactInputValue(input, 'Flattened'); await $('[data-testid="forms-flatten"]').click(); await $(apply).click();
    await browser.waitUntil(async () => /Filled.*flattened/i.test(await $('[data-testid="status-bar"]').getText()));
    await $(input).waitForExist({ reverse: true }); expect((await form(aw)).getFields()).toHaveLength(0);
    expect((await history()).undo).toHaveLength(1);
    await invokeAppCommand('edit.undo'); await value('Original A');
    expect(await $('[data-testid="forms-flatten"]').isSelected()).toBe(false);
  });
});
