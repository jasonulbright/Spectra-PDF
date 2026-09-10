import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { waitForHarness, closeAllFiles, openByPaths, getState, setActiveOp, setView, focusTab, invokeAppCommand,
  getWorkspacePageIds, selectCanvasPages, deleteSelectedCanvasPages } from '../support/harness.js';
const N = PDFName.of;
async function snapshot(path: string) {
  const pdf = await PDFDocument.load(readFileSync(path)), oc = pdf.catalog.lookup(N('OCProperties'), PDFDict);
  const off = new Set(oc.lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray().map(r => r.toString()));
  return oc.lookup(N('OCGs'), PDFArray).asArray().map(ref => ({ name: pdf.context.lookup(ref, PDFDict).lookup(N('Name'), PDFString).decodeText(), visible: !off.has(ref.toString()) }));
}
async function panel() { await setView('operations'); await setActiveOp('layers'); }
async function ready(index = 1) { await $(`[data-testid="layer-toggle-${index}"]`).waitForEnabled(); }
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<{ undo: string[] }>;
describe('Layers revision and session ownership', () => {
  let dir: string, a: string, b: string, aw: string;
  beforeEach(async () => {
    dir = mkdtempSync(resolve(__dirname, '../../docs/audit/layer-ownership.local.d-')); a = resolve(dir, 'A.pdf'); b = resolve(dir, 'B.pdf');
    for (const path of [a, b]) {
      const pdf = await PDFDocument.create(), groups = [0, 1, 2].map(() => pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Same') })));
      for (const group of groups) { const page = pdf.addPage(); page.node.set(N('Resources'), pdf.context.obj({ Properties: { Group: group } }));
        page.node.set(N('Contents'), pdf.context.register(pdf.context.flateStream('/OC /Group BDC 0 0 10 10 re f EMC'))); }
      pdf.catalog.set(N('OCProperties'), pdf.context.obj({ OCGs: groups, D: { ON: groups, OFF: [] } })); writeFileSync(path, await pdf.save());
    }
    await waitForHarness(); await closeAllFiles(); await openByPaths([a]); await panel(); await ready(); aw = (await getState()).activeFile!.workingPath;
  });
  it('pending deletion remaps duplicate names by resource identity, not list position', async () => {
    const ids = await getWorkspacePageIds(); await selectCanvasPages([ids[0]]); await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 2);
    await $('[data-testid="layer-toggle-1"]').click();
    await browser.waitUntil(async () => (await snapshot(aw)).some(l => !l.visible));
    expect((await snapshot(aw)).map(l => l.visible)).toEqual([false, true]);
  });
  it('native refusal and retry stay with A across B, Home and remount; Undo restores exact bytes', async () => {
    const before = readFileSync(aw); chmodSync(aw, 0o444);
    try { await $('[data-testid="layer-toggle-1"]').click(); await $('[data-testid="layers-error"]').waitForDisplayed();
      await openByPaths([b]); await ready(); const bw = (await getState()).activeFile!.workingPath;
      expect((await snapshot(bw)).every(l => l.visible)).toBe(true); expect(await $('[data-testid="layers-error"]').isExisting()).toBe(false);
      await focusTab('home'); await focusTab({ doc: a }); await panel(); await $('[data-testid="layers-error"]').waitForDisplayed();
      expect(readFileSync(aw).equals(before)).toBe(true); expect((await history()).undo).toHaveLength(0);
    } finally { chmodSync(aw, 0o666); }
    await ready(); await $('[data-testid="layer-toggle-1"]').click(); await browser.waitUntil(async () => !(await snapshot(aw))[1].visible);
    expect((await history()).undo).toHaveLength(1); await invokeAppCommand('edit.undo'); await ready();
    await browser.waitUntil(async () => readFileSync(aw).equals(before)); expect(await $('[data-testid="layer-toggle-1"]').isSelected()).toBe(true);
  });
  it('close/reopen retires prior errors and state', async () => {
    await $('[data-testid="layer-toggle-1"]').click(); await browser.waitUntil(async () => !(await snapshot(aw))[1].visible);
    await closeAllFiles(); await openByPaths([a]); await panel(); await ready();
    expect(await $('[data-testid="layer-toggle-1"]').isSelected()).toBe(true); expect((await history()).undo).toHaveLength(0);
  });
  it('malformed configuration refuses rather than showing a valid empty list', async () => {
    const pdf = await PDFDocument.load(readFileSync(a)); pdf.catalog.lookup(N('OCProperties'), PDFDict).set(N('D'), pdf.context.obj(42));
    const bad = resolve(dir, 'bad.pdf'); writeFileSync(bad, await pdf.save()); await openByPaths([bad]); await panel();
    await $('[data-testid="layers-error"]').waitForDisplayed(); expect(await $('[data-testid="layers-empty"]').isExisting()).toBe(false);
    expect(await $$('[data-testid^="layer-toggle-"]')).toHaveLength(0);
  });
  it('a locked default-state layer is not offered as an editable checkbox', async () => {
    const pdf = await PDFDocument.load(readFileSync(a)), oc = pdf.catalog.lookup(N('OCProperties'), PDFDict);
    oc.lookup(N('D'), PDFDict).set(N('Locked'), pdf.context.obj([oc.lookup(N('OCGs'), PDFArray).get(1)]));
    const locked = resolve(dir, 'locked.pdf'); writeFileSync(locked, await pdf.save()); await openByPaths([locked]); await panel(); await ready(0);
    expect(await $('[data-testid="layer-toggle-1"]').isEnabled()).toBe(false); expect(await $('[data-testid="layer-toggle-0"]').isEnabled()).toBe(true);
  });
});
