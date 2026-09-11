import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { closeAllFiles, commitPendingEdits, getCanvasDocs, getState, getWorkspacePageIds, importPagesIntoDoc,
  invokeAppCommand, openByPaths, saveActiveAs, selectCanvasPages, waitForActiveCanvasPageIds, waitForHarness } from '../support/harness.js';

const N = PDFName.of;
async function layerFixture(hidden: boolean, mode?: string) {
  const doc = await PDFDocument.create({ updateMetadata: false }), ctx = doc.context, page = doc.addPage([200, 200]);
  const group = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Print plate') }));
  const form = ctx.register(ctx.stream('/OC /Plate BDC 1 0 0 rg 0 0 200 200 re f EMC', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200], Resources: { Properties: { Plate: group } },
  }));
  page.node.set(N('Resources'), ctx.obj({ XObject: { Plate: form } }));
  page.node.set(N('Contents'), ctx.register(ctx.stream('/Plate Do')));
  const config = ctx.obj({ BaseState: 'ON', Order: [group], OFF: hidden ? [group] : [] });
  if (mode) config.set(N('ListMode'), N(mode));
  doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [group], D: config,
    Configs: [{ Name: PDFString.of('Alternate plate'), BaseState: 'ON', OFF: hidden ? [] : [group] }] }));
  return Buffer.from(await doc.save());
}
async function assertRaster(pageId: string, hidden: boolean) {
  await browser.waitUntil(async () => browser.execute((id: string, white: boolean) => {
    const cell = [...document.querySelectorAll('[data-page-id]')].find(el => el.getAttribute('data-page-id') === id);
    const canvas = cell?.querySelector<HTMLCanvasElement>('canvas.pageview-base.ready');
    if (!canvas?.width || !canvas.height) return false;
    const rgba = canvas.getContext('2d')?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return !!rgba && rgba[0] > 245 && rgba[3] > 245 && (white ? rgba[1] > 245 && rgba[2] > 245 : rgba[1] < 10 && rgba[2] < 10);
  }, pageId, hidden), { timeout: 20000, timeoutMsg: `The actual page raster did not remain ${hidden ? 'white (layer hidden)' : 'red (visible control)'}` });
}
async function assertLayer(path: string, pageIndex: number, hidden: boolean) {
  const doc = await PDFDocument.load(readFileSync(path), { updateMetadata: false });
  const form = doc.getPage(pageIndex).node.lookup(N('Resources'), PDFDict).lookup(N('XObject'), PDFDict).lookup(N('Plate'));
  if (!(form instanceof PDFRawStream)) throw new Error('Missing real nested Form');
  const actual = form.dict.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).get(N('Plate')) as PDFRef;
  const props = doc.catalog.lookup(N('OCProperties'), PDFDict);
  expect(props.lookup(N('OCGs'), PDFArray).asArray().map(v => v.toString())).toContain(actual.toString());
  const off = props.lookup(N('D'), PDFDict).lookupMaybe(N('OFF'), PDFArray)?.asArray().map(v => v.toString()) ?? [];
  expect(off.includes(actual.toString())).toBe(hidden);
  expect(props.lookup(N('Configs'), PDFArray).size()).toBeGreaterThan(0);
}

describe('Optional content survives live page publication', () => {
  before(async () => { await waitForHarness(); });
  for (const hidden of [false, true]) it(`keeps a nested layer's actual raster through rotation and reopen (hidden=${hidden})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../optional-content-live.local.d-'));
    const source = resolve(dir, 'source.pdf'), saved = resolve(dir, 'saved.pdf'), bytes = await layerFixture(hidden);
    writeFileSync(source, bytes); await closeAllFiles(); await openByPaths([source]);
    const ids = await waitForActiveCanvasPageIds(); await assertRaster(ids[0], hidden);
    await selectCanvasPages([ids[0]]); expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await commitPendingEdits(); await saveActiveAs(saved); await assertLayer(saved, 0, hidden);
    expect(readFileSync(source).equals(bytes)).toBe(true);
    await closeAllFiles(); await openByPaths([saved]); await assertRaster((await waitForActiveCanvasPageIds())[0], hidden);
  });
  for (const conflict of [false, true]) it(`preserves donor hidden state or refuses conflicting presentation atomically (conflict=${conflict})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../optional-content-donor-live.local.d-'));
    const own = resolve(dir, 'own.pdf'), donor = resolve(dir, 'donor.pdf'), saved = resolve(dir, 'saved.pdf');
    const a = await layerFixture(false, conflict ? 'VisiblePages' : undefined), b = await layerFixture(true, 'AllPages');
    writeFileSync(own, a); writeFileSync(donor, b); await closeAllFiles(); await openByPaths([own]); await waitForActiveCanvasPageIds();
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    await importPagesIntoDoc(donor, (await getCanvasDocs())[0].id, 1);
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 2);
    if (conflict) {
      await expect(commitPendingEdits()).rejects.toThrow('commitPendingEdits failed');
      expect(readFileSync(work).equals(before)).toBe(true);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 1);
    } else {
      await commitPendingEdits(); await saveActiveAs(saved); await assertLayer(saved, 0, false); await assertLayer(saved, 1, true);
      await closeAllFiles(); await openByPaths([saved]); const ids = await waitForActiveCanvasPageIds();
      await assertRaster(ids[0], false);
      expect(await invokeAppCommand('view.goToPage')).toBe(true);
      await $('.canvas-status-pageinput').setValue('2'); await browser.keys('Enter');
      await assertRaster(ids[1], true);
    }
    expect(readFileSync(own).equals(a)).toBe(true); expect(readFileSync(donor).equals(b)).toBe(true);
  });
});
