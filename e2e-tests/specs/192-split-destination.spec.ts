import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { answerNextSaveDialog, closeAllFiles, openByPaths, setActiveOp, setReactInputValue,
  setReactSelectValue, setView, waitForActiveCanvasPageIds, waitForHarness } from '../support/harness.js';

describe('Split writes only the selected destination', () => {
  let directory: string, source: string, original: Buffer;
  beforeEach(async () => {
    await waitForHarness(); await closeAllFiles();
    directory = mkdtempSync(resolve(__dirname, '../../split-destination.local.d-'));
    source = resolve(directory, 'source.pdf');
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]); pdf.addPage([500, 600]);
    original = Buffer.from(await pdf.save()); writeFileSync(source, original);
    await openByPaths([source]); await setView('operations'); await setActiveOp('split');
    await setReactSelectValue('[data-testid="split-mode"]', 'ranges');
    await setReactInputValue('[data-testid="split-ranges"]', '1');
    await $('[data-testid="split-run"]').waitForEnabled({ timeout: 20000 });
  });
  afterEach(async () => { await closeAllFiles(); });

  it('honors a custom filename and overlapping clicks do not replace the generated sibling', async () => {
    const selected = resolve(directory, 'Chosen report.pdf'), sibling = resolve(directory, 'split_1.pdf');
    writeFileSync(sibling, original);
    await answerNextSaveDialog(selected);
    await browser.execute(() => {
      const button = document.querySelector('[data-testid="split-run"]') as HTMLButtonElement;
      button.click(); button.click();
    });
    await browser.waitUntil(async () => existsSync(selected) && await $('[data-testid="split-run"]').isEnabled(),
      { timeout: 30000, timeoutMsg: 'Split did not finish writing the selected file' });
    const result = await PDFDocument.load(readFileSync(selected));
    expect(result.getPageCount()).toBe(1); expect(result.getPage(0).getWidth()).toBe(300);
    expect(readFileSync(sibling).equals(original)).toBe(true);
    expect(readFileSync(source).equals(original)).toBe(true);
    expect(readdirSync(directory).sort()).toEqual(['Chosen report.pdf', 'source.pdf', 'split_1.pdf']);
  });

  it('cancelling a range destination writes nothing and releases the next request', async () => {
    await answerNextSaveDialog(null); await $('[data-testid="split-run"]').click();
    await $('[data-testid="split-run"]').waitForEnabled({ timeout: 20000 });
    expect(readdirSync(directory)).toEqual(['source.pdf']);
    const selected = resolve(directory, 'After cancellation.pdf');
    await answerNextSaveDialog(selected); await $('[data-testid="split-run"]').click();
    await browser.waitUntil(async () => existsSync(selected) && await $('[data-testid="split-run"]').isEnabled(),
      { timeout: 30000, timeoutMsg: 'Cancelled split kept the request reservation' });
    expect((await PDFDocument.load(readFileSync(selected))).getPageCount()).toBe(1);
    expect(readFileSync(source).equals(original)).toBe(true);
  });

  for (const hidden of [true, false]) it(`preserves a nested layer through real engine split and reopen (hidden=${hidden})`, async () => {
    const input = resolve(directory, 'layer.pdf'), selected = resolve(directory, 'layer-split.pdf');
    const pdf = await PDFDocument.create(), ctx = pdf.context, page = pdf.addPage([200, 200]);
    const group = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Plate') }));
    const form = ctx.register(ctx.stream('/OC /Plate BDC 1 0 0 rg 0 0 200 200 re f EMC', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200], Resources: { Properties: { Plate: group } },
    }));
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Plate: form } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('/Plate Do')));
    pdf.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [group],
      D: { BaseState: 'ON', Order: [group], OFF: hidden ? [group] : [] } }));
    const bytes = Buffer.from(await pdf.save()); writeFileSync(input, bytes);
    await closeAllFiles(); await openByPaths([input]); await setView('operations'); await setActiveOp('split');
    await setReactSelectValue('[data-testid="split-mode"]', 'ranges');
    await setReactInputValue('[data-testid="split-ranges"]', '1');
    await answerNextSaveDialog(selected); await $('[data-testid="split-run"]').click();
    await browser.waitUntil(async () => existsSync(selected) && await $('[data-testid="split-run"]').isEnabled(),
      { timeout: 30000, timeoutMsg: 'Layered split did not finish' });
    const result = await PDFDocument.load(readFileSync(selected));
    const props = result.catalog.lookup(PDFName.of('OCProperties'), PDFDict);
    expect(props.lookup(PDFName.of('OCGs'), PDFArray).size()).toBe(1);
    expect(readFileSync(input).equals(bytes)).toBe(true);
    await closeAllFiles(); await openByPaths([selected]); await setView('canvas');
    const [id] = await waitForActiveCanvasPageIds();
    await browser.waitUntil(async () => browser.execute((pageId: string, white: boolean) => {
      const cell = [...document.querySelectorAll('[data-page-id]')].find(el => el.getAttribute('data-page-id') === pageId);
      const canvas = cell?.querySelector<HTMLCanvasElement>('canvas.pageview-base.ready');
      if (!canvas?.width || !canvas.height) return false;
      const rgba = canvas.getContext('2d')?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return !!rgba && rgba[0] > 245 && rgba[3] > 245 && (white ? rgba[1] > 245 && rgba[2] > 245 : rgba[1] < 10 && rgba[2] < 10);
    }, id, hidden), { timeout: 20000, timeoutMsg: 'Split changed the actual nested-layer raster' });
  });
});
