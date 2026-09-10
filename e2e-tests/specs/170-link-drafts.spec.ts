import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { waitForHarness, closeAllFiles, openByPaths, getState, invokeAppCommand, focusTab,
  setActiveOp, setReactInputValue, getWorkspacePageIds, selectCanvasPages, deleteSelectedCanvasPages } from '../support/harness.js';

const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[] }>;
async function uris(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(readFileSync(path));
  return pdf.getPages().flatMap(page => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return annots ? Array.from({ length: annots.size() }, (_, i) => annots.lookup(i, PDFDict))
      .filter(a => a.get(PDFName.of('Subtype'))?.toString() === '/Link')
      .map(a => a.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText()) : [];
  });
}
async function panel() {
  await invokeAppCommand('tools.open.links'); await invokeAppCommand('tools.panel.links'); await setActiveOp('links');
  await $('[data-testid="links-draw"]').waitForDisplayed();
}
async function draw(url: string) {
  await browser.waitUntil(async () => (await getState()).tool === 'linkdraw');
  await $('[data-page-id]').waitForDisplayed();
  const box = await browser.execute(() => {
    const r = document.querySelector('[data-page-id]')!.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const at = (x: number, y: number) => ({ x: Math.round(box.x + box.w * x), y: Math.round(box.y + box.h * y) });
  await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move(at(.15, .15)).down()
    .pause(80).move(at(.25, .22)).pause(80).move(at(.35, .3)).pause(80).up().perform();
  await $('[data-testid="link-new-url"]').waitForEnabled();
  await setReactInputValue('[data-testid="link-new-url"]', url);
}
async function create() {
  await $('[data-testid="link-new-create"]').waitForEnabled(); await $('[data-testid="link-new-create"]').click();
  await $('[data-testid="links-draw-hint"]').waitForDisplayed();
  await $('[data-testid="link-edit-1-0"]').waitForEnabled();
}

describe('link draft ownership in the live workspace', () => {
  let a: string, b: string, aw: string;
  beforeEach(async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../docs/audit/link-drafts.local.d-'));
    a = resolve(dir, 'A.pdf'); b = resolve(dir, 'B.pdf');
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]); pdf.addPage([600, 800]);
    const bytes = await pdf.save(); writeFileSync(a, bytes); writeFileSync(b, bytes);
    await waitForHarness(); await closeAllFiles(); await openByPaths([a]); await panel();
    await $('[data-testid="links-empty"]').waitForDisplayed(); aw = (await getState()).activeFile!.workingPath;
  });

  it('A never appears in B, and both drafts survive A-B-A with independent appearance', async () => {
    const beforeA = readFileSync(aw); await draw('https://example.invalid/only-a');
    await setReactInputValue('[data-testid="link-new-width"]', '2');
    await openByPaths([b]); await $('[data-testid="links-empty"]').waitForDisplayed();
    expect(await $('[data-testid="link-new-create"]').isExisting()).toBe(false);
    const bw = (await getState()).activeFile!.workingPath, beforeB = readFileSync(bw);
    expect(await uris(bw)).toEqual([]); expect(readFileSync(bw).equals(beforeB)).toBe(true);
    await draw('https://example.invalid/only-b'); await focusTab({ doc: a });
    await $('[data-testid="link-new-url"]').waitForDisplayed();
    expect(await $('[data-testid="link-new-url"]').getValue()).toBe('https://example.invalid/only-a');
    expect(await $('[data-testid="link-new-width"]').getValue()).toBe('2');
    await create(); expect(await uris(aw)).toEqual(['https://example.invalid/only-a']);
    expect(readFileSync(bw).equals(beforeB)).toBe(true); expect((await history()).undo).toHaveLength(1);
    expect(readFileSync((await history()).undo[0]).equals(beforeA)).toBe(true);
    await focusTab({ doc: b }); expect(await $('[data-testid="link-new-url"]').getValue()).toBe('https://example.invalid/only-b');
    expect(await $('[data-testid="link-new-width"]').getValue()).toBe('0'); await create();
    expect(await uris(bw)).toEqual(['https://example.invalid/only-b']); expect(await uris(a)).toEqual([]); expect(await uris(b)).toEqual([]);
  });

  it('Home/panel remount retains input and never replays a consumed rectangle after Create', async () => {
    await draw('https://example.invalid/retained'); await focusTab('home'); await focusTab({ doc: a }); await panel();
    expect(await $('[data-testid="link-new-url"]').getValue()).toBe('https://example.invalid/retained');
    await create(); await focusTab('home'); await focusTab({ doc: a }); await panel();
    await $('[data-testid="link-edit-1-0"]').waitForEnabled();
    expect(await $('[data-testid="link-new-create"]').isExisting()).toBe(false);
    expect(await uris(aw)).toEqual(['https://example.invalid/retained']);
  });

  it('closing retires a draft even when the same original is reopened', async () => {
    await draw('https://example.invalid/closed'); await closeAllFiles(); await openByPaths([a]); await panel();
    await $('[data-testid="links-empty"]').waitForDisplayed();
    expect(await $('[data-testid="link-new-create"]').isExisting()).toBe(false);
    expect(await uris((await getState()).activeFile!.workingPath)).toEqual([]);
  });

  it('existing-link target and appearance remain owned by A across a tab switch', async () => {
    await draw('https://example.invalid/original'); await create();
    await $('[data-testid="link-region"]').waitForDisplayed(); await $('[data-testid="link-region"]').click();
    await $('[data-testid="link-edit-1-0-url"]').waitForEnabled();
    await setReactInputValue('[data-testid="link-edit-1-0-url"]', 'https://example.invalid/edited');
    await setReactInputValue('[data-testid="link-edit-1-0-width"]', '3');
    await openByPaths([b]); await $('[data-testid="links-empty"]').waitForDisplayed();
    const bw = (await getState()).activeFile!.workingPath, beforeB = readFileSync(bw);
    expect(await $('[data-testid="link-save-1-0"]').isExisting()).toBe(false);
    await focusTab({ doc: a }); expect(await $('[data-testid="link-edit-1-0-url"]').getValue()).toBe('https://example.invalid/edited');
    await $('[data-testid="link-save-1-0"]').click();
    await browser.waitUntil(async () => (await uris(aw))[0] === 'https://example.invalid/edited');
    await $('[data-testid="link-edit-1-0"]').waitForEnabled();
    const pdf = await PDFDocument.load(readFileSync(aw));
    expect(pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict)
      .lookup(PDFName.of('BS'), PDFDict).get(PDFName.of('W'))?.toString()).toBe('3');
    expect(readFileSync(bw).equals(beforeB)).toBe(true); expect((await history()).undo).toHaveLength(2);
    await $('[data-testid="link-delete-1-0"]').click(); await $('[data-testid="links-empty"]').waitForDisplayed();
    expect(await uris(aw)).toEqual([]); expect((await history()).undo).toHaveLength(3);
  });

  it('native write refusal keeps the draft; retry publishes once and Undo restores exact bytes', async () => {
    const before = readFileSync(aw); await draw('https://example.invalid/retry'); chmodSync(aw, 0o444);
    try {
      await $('[data-testid="link-new-create"]').click();
      await browser.waitUntil(async () => /read.only|denied/i.test(await $('[data-testid="status-bar"]').getText()));
      expect(readFileSync(aw).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
      expect(await $('[data-testid="link-new-url"]').getValue()).toBe('https://example.invalid/retry');
    } finally { chmodSync(aw, 0o666); }
    await create(); expect(await uris(aw)).toEqual(['https://example.invalid/retry']);
    expect((await history()).undo).toHaveLength(1); await invokeAppCommand('edit.undo');
    await $('[data-testid="links-empty"]').waitForDisplayed(); expect(readFileSync(aw).equals(before)).toBe(true);
  });

  it('page deletion refuses the old address and keeps input until explicit discard/reload', async () => {
    const before = readFileSync(aw); await draw('https://example.invalid/stale');
    const ids = await getWorkspacePageIds(); await selectCanvasPages([ids[0]]); await deleteSelectedCanvasPages();
    await $('[data-testid="links-reload"]').waitForDisplayed();
    expect(await $('[data-testid="link-new-create"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="link-new-url"]').getValue()).toBe('https://example.invalid/stale');
    expect(readFileSync(aw).equals(before)).toBe(true);
    await $('[data-testid="links-reload"]').click(); await $('[data-testid="links-empty"]').waitForDisplayed();
    expect((await PDFDocument.load(readFileSync(aw))).getPageCount()).toBe(1); expect(await uris(aw)).toEqual([]);
    await draw('https://example.invalid/remaining'); await create(); expect(await uris(aw)).toEqual(['https://example.invalid/remaining']);
  });
});
