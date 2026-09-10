import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { closeAllFiles, commitPendingEdits, deleteSelectedCanvasPages, getState, getWorkspacePageIds,
  invokeAppCommand, openByPaths, selectCanvasPages, setActiveOp, setView, signActiveFileInPlace, verifyActiveSignatures, waitForHarness } from '../support/harness.js';
const N = PDFName.of;
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[] }>;
async function rotate(id: string) {
  await selectCanvasPages([id]); expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
  await browser.waitUntil(async () => browser.execute((pageId: string) => {
    const page = [...document.querySelectorAll('[data-page-id]')].find(el => el.getAttribute('data-page-id') === pageId);
    return page?.getAttribute('data-natural-w') === '800' && page?.getAttribute('data-natural-h') === '600';
  }, id), { timeout: 15000 });
}
async function assertActions(path: string) {
  const pdf = await PDFDocument.load(readFileSync(path)), aa = pdf.catalog.lookup(N('AA'), PDFDict);
  expect(pdf.catalog.get(N('OpenAction'))).toEqual(aa.get(N('WC')));
  const action = aa.lookup(N('WC'), PDFDict); expect(action.lookup(N('JS'), PDFString).decodeText()).toBe('// retained; never executed');
  expect(action.lookup(N('Next'), PDFArray).lookup(0, PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(pdf.getPage(1).ref);
  expect(action.lookup(N('Next'), PDFArray).get(1)).toEqual(aa.get(N('WC')));
  return pdf;
}
describe('Document action preservation through actual page commits', () => {
  let dir: string, source: string, work: string, before: Buffer;
  beforeEach(async () => {
    dir = mkdtempSync(resolve(__dirname, '../../docs/audit/document-actions-live.local.d-')); source = resolve(dir, 'source.pdf');
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]); pdf.addPage([610, 800]);
    const action = pdf.context.obj({ S: 'JavaScript', JS: PDFString.of('// retained; never executed') }), ref = pdf.context.register(action);
    action.set(N('Next'), pdf.context.obj([{ S: 'GoTo', D: [pdf.getPage(1).ref, 'Fit'] }, ref]));
    pdf.catalog.set(N('AA'), pdf.context.obj({ WC: ref })); pdf.catalog.set(N('OpenAction'), ref); writeFileSync(source, await pdf.save());
    await waitForHarness(); await closeAllFiles(); await openByPaths([source]); await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 2);
    work = (await getState()).activeFile!.workingPath; before = readFileSync(work);
  });
  it('rotation preserves the graph and page identity; one Undo restores exact bytes', async () => {
    await rotate((await getWorkspacePageIds())[0]); await commitPendingEdits();
    expect((await assertActions(work)).getPage(0).getRotation().angle).toBe(90); expect((await history()).undo).toHaveLength(1);
    expect(readFileSync(source).equals(before)).toBe(true); await invokeAppCommand('edit.undo');
    await browser.waitUntil(async () => readFileSync(work).equals(before)); expect((await history()).undo).toHaveLength(0);
  });
  it('an approval-signed action graph survives rotation as an incremental append', async () => {
    const priorIds = await getWorkspacePageIds();
    await setView('operations'); await setActiveOp('signatures');
    await signActiveFileInPlace({ pfxPath: resolve(__dirname, '../fixtures/test-signer.pfx'), password: 'testpw' });
    const signed = readFileSync(work);
    await browser.waitUntil(async () => { const live = await getWorkspacePageIds(); return live.length === 2 && live.every(id => !priorIds.includes(id)); });
    await setView('canvas');
    await rotate((await getWorkspacePageIds())[0]); await commitPendingEdits();
    expect(readFileSync(work).subarray(0, signed.length).equals(signed)).toBe(true);
    expect((await assertActions(work)).getPage(0).getRotation().angle).toBe(90);
    await setView('operations'); await setActiveOp('signatures');
    const verified = await verifyActiveSignatures(); expect(verified.signatures).toHaveLength(1);
    expect(verified.all_valid).toBe(true);
  });
  it('deleting the action target refuses atomically; undoing the deletion permits a faithful edit', async () => {
    const ids = await getWorkspacePageIds(); await selectCanvasPages([ids[1]]); await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 1);
    await expect(commitPendingEdits()).rejects.toThrow('commitPendingEdits failed');
    expect(readFileSync(work).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
    expect((await getWorkspacePageIds()).length).toBe(1); await invokeAppCommand('edit.undo');
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 2);
    await rotate((await getWorkspacePageIds())[0]); await commitPendingEdits(); await assertActions(work);
  });
  it('native publication refusal retains pending rotation for retry without losing actions', async () => {
    await rotate((await getWorkspacePageIds())[0]); chmodSync(work, 0o444);
    try {
      await expect(commitPendingEdits()).rejects.toThrow('commitPendingEdits failed');
      expect(readFileSync(work).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
    } finally { chmodSync(work, 0o666); }
    await commitPendingEdits(); expect((await assertActions(work)).getPage(0).getRotation().angle).toBe(90);
    expect((await history()).undo).toHaveLength(1); expect(readFileSync(source).equals(before)).toBe(true);
  });
  it('an unreadable action root refuses rather than publishing an action-free file', async () => {
    const pdf = await PDFDocument.load(readFileSync(source)); pdf.catalog.set(N('AA'), PDFNumber.of(42));
    const bad = resolve(dir, 'malformed.pdf'); writeFileSync(bad, await pdf.save()); await closeAllFiles(); await openByPaths([bad]);
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 2);
    work = (await getState()).activeFile!.workingPath; before = readFileSync(work);
    await rotate((await getWorkspacePageIds())[0]); await expect(commitPendingEdits()).rejects.toThrow('commitPendingEdits failed');
    expect(readFileSync(work).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0); await invokeAppCommand('edit.undo');
  });
});
