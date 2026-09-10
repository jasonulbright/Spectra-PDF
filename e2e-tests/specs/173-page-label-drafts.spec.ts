import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { closeAllFiles, deleteCanvasPagesAndWait, focusTab, getState, waitForActiveCanvasPageIds, invokeAppCommand,
  openByPaths, setActiveOp, setReactInputValue, setView, waitForHarness } from '../support/harness.js';

const prefix = '[data-testid="pagelabel-range"] input[type="text"]';
const apply = '[data-testid="pagelabel-apply"]';
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[] }>;
async function shown(value: string) { await $(prefix).waitForDisplayed(); await browser.waitUntil(async () => await $(prefix).getValue() === value); }
async function panel() { await setView('operations'); await setActiveOp('pagelabels'); }
async function decoded(path: string) {
  const pdf = await PDFDocument.load(readFileSync(path)), root = pdf.catalog.lookup(PDFName.of('PageLabels'), PDFDict);
  const nums = root.lookup(PDFName.of('Nums'), PDFArray), ranges: { start: number; prefix: string; number: number }[] = [];
  for (let i = 0; i < nums.size(); i += 2) {
    const r = nums.lookup(i + 1, PDFDict); ranges.push({ start: nums.lookup(i, PDFNumber).asNumber(),
      prefix: r.lookup(PDFName.of('P'), PDFString).decodeText(), number: r.lookupMaybe(PDFName.of('St'), PDFNumber)?.asNumber() ?? 1 });
  }
  return pdf.getPages().map((p, i) => { const r = ranges.filter(r => r.start <= i).at(-1)!;
    return { width: p.getWidth(), label: r.prefix + (r.number + i - r.start) }; });
}
async function saved(path: string, value: string) { await browser.waitUntil(async () => (await decoded(path))[0].label === value); }

describe('page-label drafts and physical-page semantics', () => {
  let dir: string, a: string, b: string, aw: string;
  beforeEach(async () => {
    dir = mkdtempSync(resolve(__dirname, '../../docs/audit/page-label-drafts.local.d-')); a = resolve(dir, 'A.pdf'); b = resolve(dir, 'B.pdf');
    for (const [path, name] of [[a, 'A-'], [b, 'B-']]) {
      const pdf = await PDFDocument.create(); for (const width of [600, 610, 620]) pdf.addPage([width, 800]);
      pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({ Nums: [0, { S: 'D', P: PDFString.of(name), St: 5 }] }));
      writeFileSync(path, await pdf.save());
    }
    await waitForHarness(); await closeAllFiles(); await openByPaths([a]); await panel(); await shown('A-'); aw = (await getState()).activeFile!.workingPath;
  });
  it('retains independent drafts across tabs, Home and tool remount without auto-applying', async () => {
    const before = readFileSync(aw); await setReactInputValue(prefix, 'Draft A-'); await openByPaths([b]); await shown('B-');
    const bw = (await getState()).activeFile!.workingPath, beforeB = readFileSync(bw); await setReactInputValue(prefix, 'Draft B-');
    await focusTab('home'); await focusTab({ doc: a }); await panel(); await shown('Draft A-');
    await setActiveOp('document_js'); await $('[data-testid="docjs-add"]').waitForDisplayed(); await panel(); await shown('Draft A-');
    expect(readFileSync(aw).equals(before)).toBe(true); expect(readFileSync(bw).equals(beforeB)).toBe(true);
    await $(apply).click(); await saved(aw, 'Draft A-5'); await focusTab({ doc: b }); await shown('Draft B-');
    expect(readFileSync(bw).equals(beforeB)).toBe(true);
  });
  it('native refusal preserves input; retry publishes one undo and restores exact bytes', async () => {
    const before = readFileSync(aw); chmodSync(aw, 0o444);
    try {
      await setReactInputValue(prefix, 'Retry-'); await $(apply).click(); await $('[data-testid="pagelabel-notice"]').waitForDisplayed();
      await openByPaths([b]); await shown('B-'); await focusTab({ doc: a }); await shown('Retry-');
      expect(readFileSync(aw).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
    } finally { chmodSync(aw, 0o666); }
    await $(apply).waitForEnabled(); await $(apply).click(); await saved(aw, 'Retry-5'); expect((await history()).undo).toHaveLength(1);
    await invokeAppCommand('edit.undo'); await shown('A-'); expect(readFileSync(aw).equals(before)).toBe(true);
  });
  it('close retires unapplied input instead of resurrecting it on reopening', async () => {
    await setReactInputValue(prefix, 'Closed-'); await closeAllFiles(); await openByPaths([a]); await panel(); await shown('A-');
    expect((await history()).undo).toHaveLength(0);
  });
  it('deleting inside a numeric range preserves the surviving page numbers', async () => {
    const ids = await waitForActiveCanvasPageIds(); await deleteCanvasPagesAndWait([ids[1]]);
    await setReactInputValue(prefix, 'Edited-'); await $(apply).click(); await saved(aw, 'Edited-5');
    expect(await decoded(aw)).toEqual([{ width: 600, label: 'Edited-5' }, { width: 620, label: 'Edited-7' }]);
    expect((await history()).undo).toHaveLength(2);
  });
  it('an unrelated revision keeps dirty input blocked until explicit discard/reload', async () => {
    await setReactInputValue(prefix, 'Saved-'); await $(apply).click(); await saved(aw, 'Saved-5');
    await setReactInputValue(prefix, 'Unsaved-'); await invokeAppCommand('edit.undo');
    await $('[data-testid="pagelabel-reload"]').waitForEnabled(); expect(await $(prefix).getValue()).toBe('Unsaved-');
    expect(await $(apply).isEnabled()).toBe(false); expect((await decoded(aw))[0].label).toBe('A-5');
    await $('[data-testid="pagelabel-reload"]').click(); await shown('A-');
  });
  it('malformed label trees do not seed an editable empty list', async () => {
    const pdf = await PDFDocument.load(readFileSync(a)); pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({ Nums: [0, { P: PDFString.of('Keep') }, 1] }));
    const bad = resolve(dir, 'bad.pdf'); writeFileSync(bad, await pdf.save()); await openByPaths([bad]); await panel();
    await $('[data-testid="pagelabel-notice"]').waitForDisplayed(); expect(await $('[data-testid="pagelabel-add"]').isEnabled()).toBe(false);
    expect(await $(apply).isEnabled()).toBe(false); expect(await $$(prefix)).toHaveLength(0);
  });
  it('nested number-tree ranges are all available for editing', async () => {
    const pdf = await PDFDocument.load(readFileSync(a));
    const kids = [0, 2].map(i => pdf.context.register(pdf.context.obj({ Limits: [i, i], Nums: [i, { S: 'D', P: PDFString.of(`Nested${i}-`), St: 8 }] })));
    pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({ Kids: kids }));
    const nested = resolve(dir, 'nested.pdf'); writeFileSync(nested, await pdf.save()); await openByPaths([nested]); await panel(); await shown('Nested0-');
    expect(await $$('[data-testid="pagelabel-range"]')).toHaveLength(2);
    await setReactInputValue(prefix, 'Updated-'); await $(apply).click(); const work = (await getState()).activeFile!.workingPath;
    await saved(work, 'Updated-8'); expect(await decoded(work)).toEqual([
      { width: 600, label: 'Updated-8' }, { width: 610, label: 'Updated-9' }, { width: 620, label: 'Nested2-8' }]);
  });
});
