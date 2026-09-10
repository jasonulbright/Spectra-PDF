import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { waitForHarness, closeAllFiles, openByPaths, getState, getArticles, addArticleBead,
  saveArticles, setReactInputValue, focusTab, invokeAppCommand, getWorkspacePageIds,
  selectCanvasPages, deleteSelectedCanvasPages } from '../support/harness.js';

const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[]; buffer: number[] }>;
async function titles(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(readFileSync(path));
  const raw = pdf.catalog.lookupMaybe(PDFName.of('Threads'), PDFArray);
  return raw ? Array.from({ length: raw.size() }, (_, i) => raw.lookup(i, PDFDict)
    .lookup(PDFName.of('I'), PDFDict).lookup(PDFName.of('Title'), PDFString).decodeText()) : [];
}
async function panel() {
  if (await $('[data-testid="navicon-articles"]').getAttribute('aria-pressed') !== 'true')
    await $('[data-testid="navicon-articles"]').click();
  await $('[data-testid="articles-panel"]').waitForDisplayed();
}
async function author(title: string) {
  await $('[data-testid="article-add"]').waitForEnabled();
  await $('[data-testid="article-add"]').click();
  await $('[data-testid="article-title"]').waitForDisplayed();
  await setReactInputValue('[data-testid="article-title"]', title);
  await addArticleBead(1, [20, 20, 120, 100]);
  await browser.waitUntil(async () => (await getArticles())[0]?.beads.length === 1);
}

describe('article draft ownership in the live workspace', () => {
  let a: string, b: string, aw: string;
  beforeEach(async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'spectra-articles-owner-'));
    a = resolve(dir, 'A.pdf'); b = resolve(dir, 'B.pdf');
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]); pdf.addPage([300, 400]);
    const bytes = await pdf.save(); writeFileSync(a, bytes); writeFileSync(b, bytes);
    await waitForHarness(); await closeAllFiles(); await openByPaths([a]); await panel();
    await $('[data-testid="articles-empty"]').waitForDisplayed();
    aw = (await getState()).activeFile!.workingPath;
  });

  it('never puts A in B, and restores two independent unsaved drafts across A-B-A', async () => {
    const beforeA = readFileSync(aw); await author('Only A');
    await openByPaths([b]); await $('[data-testid="articles-empty"]').waitForDisplayed();
    const bw = (await getState()).activeFile!.workingPath, beforeB = readFileSync(bw);
    await saveArticles(); expect(readFileSync(bw).equals(beforeB)).toBe(true); expect(await titles(bw)).toEqual([]);
    await author('Only B'); await focusTab({ doc: a });
    await browser.waitUntil(async () => (await getArticles())[0]?.title === 'Only A');
    await saveArticles(); expect(await titles(aw)).toEqual(['Only A']);
    expect(readFileSync(bw).equals(beforeB)).toBe(true); expect((await history()).undo).toHaveLength(1);
    expect(readFileSync((await history()).undo[0]).equals(beforeA)).toBe(true);
    await focusTab({ doc: b });
    await browser.waitUntil(async () => (await getArticles())[0]?.title === 'Only B');
    await saveArticles(); expect(await titles(bw)).toEqual(['Only B']); expect(await titles(aw)).toEqual(['Only A']);
    expect(await titles(a)).toEqual([]); expect(await titles(b)).toEqual([]);
  });

  it('keeps the draft through a navigation-panel unmount and Home visit', async () => {
    await author('Keep me'); await $('[data-testid="navicon-bookmarks"]').click();
    await panel(); expect((await getArticles())[0].title).toBe('Keep me');
    expect((await getArticles())[0].beads).toHaveLength(1);
    await focusTab('home'); await focusTab({ doc: a }); await panel();
    expect((await getArticles())[0].title).toBe('Keep me');
    await saveArticles(); expect(await titles(aw)).toEqual(['Keep me']);
  });

  it('does not resurrect a closed working-session draft on reopen', async () => {
    await author('Closed draft'); await closeAllFiles(); await openByPaths([a]); await panel();
    await $('[data-testid="articles-empty"]').waitForDisplayed();
    expect(await getArticles()).toEqual([]); await saveArticles();
    expect(await titles((await getState()).activeFile!.workingPath)).toEqual([]);
  });

  it('retains input after native publication refusal, retries once, and undoes exact bytes', async () => {
    const before = readFileSync(aw); await author('Retry'); chmodSync(aw, 0o444);
    try {
      await saveArticles();
      expect(await $('[data-testid="article-status"]').getText()).toMatch(/read.only|denied/i);
      expect(readFileSync(aw).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
      expect((await getArticles())[0].title).toBe('Retry');
    } finally { chmodSync(aw, 0o666); }
    await saveArticles(); expect(await titles(aw)).toEqual(['Retry']); expect((await history()).undo).toHaveLength(1);
    await invokeAppCommand('edit.undo');
    await browser.waitUntil(async () => (await history()).undo.length === 0);
    expect(readFileSync(aw).equals(before)).toBe(true);
    await $('[data-testid="articles-empty"]').waitForDisplayed();
  });

  it('page deletion cannot silently retarget a draft bead; only explicit discard reloads', async () => {
    await author('Original page one'); const before = readFileSync(aw);
    const ids = await getWorkspacePageIds(); expect(ids).toHaveLength(2);
    await selectCanvasPages([ids[0]]); await deleteSelectedCanvasPages();
    await $('[data-testid="article-reload"]').waitForDisplayed();
    expect(await $('[data-testid="article-save"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="article-status"]').getText()).toContain('retained');
    await saveArticles(); expect(readFileSync(aw).equals(before)).toBe(true);
    expect((await getArticles())[0].title).toBe('Original page one');
    await $('[data-testid="article-reload"]').click(); await $('[data-testid="articles-empty"]').waitForDisplayed();
    expect((await PDFDocument.load(readFileSync(aw))).getPageCount()).toBe(1);
    expect(await titles(aw)).toEqual([]); await author('Remaining page'); await saveArticles();
    expect(await titles(aw)).toEqual(['Remaining page']);
  });
});
