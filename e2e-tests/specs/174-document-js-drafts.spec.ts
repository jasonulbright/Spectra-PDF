import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { closeAllFiles, deleteCanvasPagesAndWait, focusTab, getState, waitForActiveCanvasPageIds, invokeAppCommand,
  openByPaths, setActiveOp, setReactInputValue, setView, waitForHarness } from '../support/harness.js';
const editor = '[data-testid="docjs-editor"]', save = '[data-testid="docjs-save"]';
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[] }>;
async function panel() { await setView('operations'); await setActiveOp('document_js'); }
async function shown(text: string) {
  // Reads and remounts can replace the textarea between WebDriver commands.
  // Query the live node and its value in one renderer turn, without retaining
  // an element handle to an earlier document's editor.
  await browser.waitUntil(async () => browser.execute((selector: string, expected: string) => {
    const element = document.querySelector<HTMLTextAreaElement>(selector);
    return !!element && element.getClientRects().length > 0 && element.value === expected;
  }, editor, text));
}
async function decoded(path: string) {
  const pdf = await PDFDocument.load(readFileSync(path));
  const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('JavaScript'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
  return Array.from({ length: names.size() / 2 }, (_, i) => {
    const name = names.lookup(i * 2, PDFString).decodeText(), js = names.lookup(i * 2 + 1, PDFDict).lookup(PDFName.of('JS'));
    if (js instanceof PDFString) return { name, js: js.decodeText() };
    if (!(js instanceof PDFRawStream)) throw new Error('Unexpected script representation');
    const bytes = decodePDFRawStream(js).decode();
    return { name, js: new TextDecoder(bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true }).decode(bytes) };
  });
}
async function saved(path: string, text: string) { await browser.waitUntil(async () => (await decoded(path))[0].js === text); }
describe('Document JavaScripts working-session drafts', () => {
  let dir: string, a: string, b: string, aw: string;
  beforeEach(async () => {
    dir = mkdtempSync(resolve(__dirname, '../../docs/audit/document-js-drafts.local.d-')); a = resolve(dir, 'A.pdf'); b = resolve(dir, 'B.pdf');
    for (const [path, label] of [[a, 'A'], [b, 'B']]) {
      const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
      pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({ JavaScript: { Names: [PDFString.of(' Shared name '),
        { S: 'JavaScript', JS: PDFString.of(`// Original ${label}`) }] } })); writeFileSync(path, await pdf.save());
    }
    await waitForHarness(); await closeAllFiles(); await openByPaths([a]); await panel(); await shown('// Original A'); aw = (await getState()).activeFile!.workingPath;
  });
  it('A-B-A, Home and tool remount retain drafts without autosave or name trimming', async () => {
    const before = readFileSync(aw); await setReactInputValue(editor, '// Draft A'); await openByPaths([b]); await shown('// Original B');
    const bw = (await getState()).activeFile!.workingPath, beforeB = readFileSync(bw); await setReactInputValue(editor, '// Draft B');
    await focusTab('home'); await focusTab({ doc: a }); await panel(); await shown('// Draft A');
    await setActiveOp('pagelabels'); await $('[data-testid="pagelabel-add"]').waitForDisplayed(); await panel(); await shown('// Draft A');
    expect(readFileSync(aw).equals(before)).toBe(true); expect(readFileSync(bw).equals(beforeB)).toBe(true);
    await $(save).click(); await saved(aw, '// Draft A'); expect((await decoded(aw))[0].name).toBe(' Shared name ');
    await focusTab({ doc: b }); await shown('// Draft B'); expect(readFileSync(bw).equals(beforeB)).toBe(true);
  });
  it('native refusal retains input; retry publishes one undo and Undo restores exact bytes', async () => {
    const before = readFileSync(aw); chmodSync(aw, 0o444);
    try {
      await setReactInputValue(editor, '// Retry'); await $(save).click(); await $('[data-testid="docjs-error"]').waitForDisplayed();
      await openByPaths([b]); await shown('// Original B'); await focusTab({ doc: a }); await shown('// Retry');
      expect(readFileSync(aw).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
    } finally { chmodSync(aw, 0o666); }
    await $(save).waitForEnabled(); await $(save).click(); await saved(aw, '// Retry'); expect((await history()).undo).toHaveLength(1);
    await invokeAppCommand('edit.undo'); await shown('// Original A'); expect(readFileSync(aw).equals(before)).toBe(true);
  });
  it('close/reopen retires old input', async () => {
    await setReactInputValue(editor, '// Closed'); await closeAllFiles(); await openByPaths([a]); await panel(); await shown('// Original A');
    expect((await history()).undo).toHaveLength(0);
  });
  it('pending page edits retain stale text and require explicit discard/reload', async () => {
    await setReactInputValue(editor, '// Retained'); const ids = await waitForActiveCanvasPageIds(); await deleteCanvasPagesAndWait([ids[0]]);
    await $('[data-testid="docjs-reload"]').waitForDisplayed(); expect(await $(editor).getValue()).toBe('// Retained'); expect(await $(save).isEnabled()).toBe(false);
    await $('[data-testid="docjs-reload"]').click(); await shown('// Original A');
    await setReactInputValue(editor, '// After reload'); await $(save).click(); await saved(aw, '// After reload');
  });
  it('foreign revision blocks a dirty draft until explicit reload', async () => {
    await setReactInputValue(editor, '// Saved'); await $(save).click(); await saved(aw, '// Saved');
    await setReactInputValue(editor, '// Retained'); await invokeAppCommand('edit.undo');
    await $('[data-testid="docjs-reload"]').waitForDisplayed(); expect(await $(editor).getValue()).toBe('// Retained'); expect(await $(save).isEnabled()).toBe(false);
    await $('[data-testid="docjs-reload"]').click(); await shown('// Original A');
  });
  it('a malformed action cannot seed an editable partial script list', async () => {
    const pdf = await PDFDocument.load(readFileSync(a));
    const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('JavaScript'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
    names.push(PDFString.of('Broken')); names.push(pdf.context.obj({ S: 'JavaScript', JS: 42 }));
    const bad = resolve(dir, 'bad.pdf'); writeFileSync(bad, await pdf.save()); await openByPaths([bad]); await panel();
    await $('[data-testid="docjs-error"]').waitForDisplayed(); expect(await $('[data-testid="docjs-add"]').isEnabled()).toBe(false);
    expect(await $(save).isEnabled()).toBe(false); expect(await $$(editor)).toHaveLength(0);
    expect(await $('[data-testid="docjs-empty"]').isExisting()).toBe(false);
  });
});
