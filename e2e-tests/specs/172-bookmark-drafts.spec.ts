import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { waitForHarness, closeAllFiles, openByPaths, getState, setReactInputValue, focusTab, invokeAppCommand,
  waitForActiveCanvasPageIds, deleteCanvasPagesAndWait } from '../support/harness.js';

const input = '[data-testid="bookmark-title"]';
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[] }>;
async function outlines(path: string) {
  const pdf = await PDFDocument.load(readFileSync(path)); const root = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const out: { title: string; page: number; width: number | null }[] = [];
  let item = root?.lookupMaybe(PDFName.of('First'), PDFDict);
  while (item) {
    const dest = item.lookupMaybe(PDFName.of('Dest'), PDFArray)?.get(0);
    const page = pdf.getPages().findIndex(p => p.ref.toString() === dest?.toString());
    out.push({ title: item.lookup(PDFName.of('Title'), PDFString).decodeText(), page: page + 1, width: page < 0 ? null : pdf.getPage(page).getWidth() });
    item = item.lookupMaybe(PDFName.of('Next'), PDFDict);
  }
  return out;
}
async function panel() {
  if (await $('[data-testid="navicon-bookmarks"]').getAttribute('aria-pressed') !== 'true') await $('[data-testid="navicon-bookmarks"]').click();
  await $('[data-testid="bookmarks-panel"]').waitForDisplayed();
}
async function shown(title: string) { await $(input).waitForDisplayed(); await browser.waitUntil(async () => await $(input).getValue() === title); }
async function type(title: string) { await $(input).click(); await setReactInputValue(input, title); }
async function saved(path: string, title: string) { await browser.waitUntil(async () => (await outlines(path))[0]?.title === title); }

describe('bookmark draft sessions and destination identity', () => {
  let a: string, b: string, aw: string;
  beforeEach(async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../docs/audit/bookmark-drafts.local.d-'));
    a = resolve(dir, 'A.pdf'); b = resolve(dir, 'B.pdf');
    for (const [path, title] of [[a, 'Original A'], [b, 'Original B']]) {
      const pdf = await PDFDocument.create(); for (const width of [600, 610, 620]) pdf.addPage([width, 800]);
      const root = pdf.context.register(pdf.context.obj({ Type: 'Outlines' }));
      const item = pdf.context.register(pdf.context.obj({ Title: PDFString.of(title), Parent: root, Dest: [pdf.getPage(1).ref, 'Fit'] }));
      const dict = pdf.context.lookup(root, PDFDict); dict.set(PDFName.of('First'), item); dict.set(PDFName.of('Last'), item);
      dict.set(PDFName.of('Count'), pdf.context.obj(1)); pdf.catalog.set(PDFName.of('Outlines'), root);
      writeFileSync(path, await pdf.save());
    }
    await waitForHarness(); await closeAllFiles(); await openByPaths([a]); await panel(); await shown('Original A');
    aw = (await getState()).activeFile!.workingPath;
  });
  it('pending deletion remaps the bookmark to the same physical page before renaming', async () => {
    const ids = await waitForActiveCanvasPageIds(); await deleteCanvasPagesAndWait([ids[0]]);
    await type('Renamed'); await browser.keys(['Enter']); await saved(aw, 'Renamed');
    expect(await outlines(aw)).toEqual([{ title: 'Renamed', page: 1, width: 610 }]);
    expect((await PDFDocument.load(readFileSync(aw))).getPageCount()).toBe(2);
    expect((await history()).undo).toHaveLength(2);
  });
  it('native refusal preserves input across A-B-A and pane remount without writing into B', async () => {
    const before = readFileSync(aw); chmodSync(aw, 0o444);
    try {
      await type('Only A'); await browser.keys(['Enter']); await $('[data-testid="bookmarks-retry"]').waitForEnabled();
      await openByPaths([b]); await shown('Original B'); const bw = (await getState()).activeFile!.workingPath, beforeB = readFileSync(bw);
      await focusTab({ doc: a }); await shown('Only A');
      await $('[data-testid="navicon-pages"]').click(); await panel(); await shown('Only A');
      expect(readFileSync(aw).equals(before)).toBe(true); expect(readFileSync(bw).equals(beforeB)).toBe(true);
      expect((await history()).undo).toHaveLength(0);
    } finally { chmodSync(aw, 0o666); }
    await $('[data-testid="bookmarks-retry"]').waitForEnabled(); await $('[data-testid="bookmarks-retry"]').click(); await saved(aw, 'Only A');
    expect((await history()).undo).toHaveLength(1); await invokeAppCommand('edit.undo'); await shown('Original A');
    expect(readFileSync(aw).equals(before)).toBe(true);
  });
  it('document switches finish the old document gesture, not the newly active tree', async () => {
    await type('A renamed'); await openByPaths([b]); await shown('Original B');
    const bw = (await getState()).activeFile!.workingPath;
    await type('B renamed'); await focusTab({ doc: a }); await shown('A renamed');
    await saved(aw, 'A renamed'); await saved(bw, 'B renamed');
    expect((await outlines(a))[0].title).toBe('Original A'); expect((await outlines(b))[0].title).toBe('Original B');
  });
  it('close retires a refused draft; reopening the original cannot resurrect it', async () => {
    chmodSync(aw, 0o444);
    try { await type('Closed'); await browser.keys(['Enter']); await $('[data-testid="bookmarks-retry"]').waitForEnabled(); }
    finally { chmodSync(aw, 0o666); }
    await closeAllFiles(); await openByPaths([a]); await panel(); await shown('Original A');
    expect((await history()).undo).toHaveLength(0);
  });
  it('an unrelated revision preserves dirty input with a refusal until explicit discard', async () => {
    await type('Saved'); await browser.keys(['Enter']); await saved(aw, 'Saved');
    await type('Unsaved'); await invokeAppCommand('edit.undo'); await $('[data-testid="bookmarks-reload"]').waitForEnabled();
    expect(await $(input).getValue()).toBe('Unsaved'); expect(await $(input).isEnabled()).toBe(false);
    expect((await outlines(aw))[0].title).toBe('Original A');
    await $('[data-testid="bookmarks-reload"]').click(); await shown('Original A');
  });
  it('deleting the destination refuses instead of silently choosing the next page', async () => {
    const ids = await waitForActiveCanvasPageIds(); await deleteCanvasPagesAndWait([ids[1]]);
    await type('Retained'); await browser.keys(['Enter']); await $('[data-testid="bookmarks-reload"]').waitForEnabled();
    expect(await $(input).getValue()).toBe('Retained'); expect(await $(input).isEnabled()).toBe(false);
    expect((await PDFDocument.load(readFileSync(aw))).getPageCount()).toBe(2);
    expect((await outlines(aw)).some(n => n.title === 'Retained')).toBe(false);
  });
});
