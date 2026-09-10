import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, closeAllFiles, getState, setView, getWorkspacePageIds,
  placeNewField, createPlacedField, invokeAppCommand } from '../support/harness.js';

type History = { undo: string[]; redo: string[]; buffer: number[] };
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<History>;

describe('form creation publication', () => {
  let directory: string;
  let source: string;
  let working: string;
  before(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-form-publication-'));
    source = resolve(directory, 'form.pdf');
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
    writeFileSync(source, await pdf.save());
  });
  after(async () => { await closeAllFiles(); rmSync(directory, { recursive: true, force: true }); });
  beforeEach(async () => {
    await waitForHarness(); await closeAllFiles(); await openByPaths([source]); await setView('canvas');
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 1);
    working = (await getState()).activeFile!.workingPath;
    await placeNewField({ x: 0.15, y: 0.15, w: 0.4, h: 0.25 });
  });

  it('a single field publishes one complete revision that can be undone and redone', async () => {
    const before = readFileSync(working);
    await createPlacedField({ name: 'new_field', type: 'text' }, { path: source });
    const created = readFileSync(working);
    expect((await PDFDocument.load(created)).getForm().getFields().map(f => f.getName())).toEqual(['new_field']);
    const h = await history(); expect(h.undo).toHaveLength(1);
    expect(readFileSync(h.undo[0]).equals(before)).toBe(true);
    expect(Buffer.from(h.buffer).equals(created)).toBe(true);
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await history()).undo.length === 0);
    expect(readFileSync(working).equals(before)).toBe(true);
    expect(await invokeAppCommand('edit.redo')).toBe(true);
    await browser.waitUntil(async () => (await history()).undo.length === 1);
    expect(readFileSync(working).equals(created)).toBe(true);
    expect(Buffer.from((await history()).buffer).equals(created)).toBe(true);
  });

  it('a vertical option list is font-bound and drawn by the real engine before publication', async () => {
    const before = readFileSync(working);
    await createPlacedField({ name: 'cities', type: 'optionlist', options: ['東京', '大阪'],
      writing: 'vertical', script: 'japanese' }, { path: source });
    const pdf = await PDFDocument.load(readFileSync(working));
    const field = pdf.getForm().getOptionList('cities');
    expect(field.getOptions()).toEqual(['東京', '大阪']);
    const da = field.acroField.getDefaultAppearance()!;
    const fontName = /\/(\S+)\s+[\d.]+\s+Tf/.exec(da)![1];
    const acro = pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const font = acro.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of(fontName), PDFDict);
    expect(font.get(PDFName.of('Subtype'))?.toString()).toBe('/Type0');
    expect(font.get(PDFName.of('Encoding'))?.toString()).toMatch(/-V$/);
    const appearance = field.acroField.getWidgets()[0].getAppearances()?.normal;
    expect(appearance).toBeInstanceOf(PDFRawStream);
    const body = Buffer.from(decodePDFRawStream(appearance as PDFRawStream).decode()).toString('latin1');
    expect(body).toContain('Tf'); expect(body).toMatch(/Tj|TJ/);
    const h = await history(); expect(h.undo).toHaveLength(1);
    expect(readFileSync(h.undo[0]).equals(before)).toBe(true);
    expect(Buffer.from(h.buffer).equals(readFileSync(working))).toBe(true);
  });

  it('a native replacement refusal preserves bytes and history, then the same placement retries', async () => {
    const before = readFileSync(working); const prior = await history();
    let failure = '';
    chmodSync(working, 0o444);
    try {
      await createPlacedField({ name: 'retry_field', type: 'text' }).catch(error => { failure = String(error); });
      expect(failure.toLowerCase()).toMatch(/read.only|denied/);
      expect(readFileSync(working).equals(before)).toBe(true); expect(await history()).toEqual(prior);
    } finally { chmodSync(working, 0o666); }
    await createPlacedField({ name: 'retry_field', type: 'text' }, { path: source });
    expect((await history()).undo).toHaveLength(1);
    expect((await PDFDocument.load(readFileSync(working))).getForm().getFields().map(f => f.getName())).toEqual(['retry_field']);
  });
});
