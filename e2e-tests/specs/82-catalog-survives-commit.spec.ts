import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  selectCanvasPages,
  getWorkspacePageIds,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
  deleteSelectedCanvasPages,
  getCanvasDocs,
  importPagesIntoDoc,
  waitForActiveCanvasPageIds,
  deleteCanvasPagesAndWait,
} from '../support/harness.js';

// The catalog carry (lib/catalog-carry.ts): bookmarks and page labels
// survive a COMMITTED page edit. Before the carry, one committed rotation
// silently deleted /Outlines and /PageLabels (with /Lang, /ViewerPreferences
// and the layers config — those are pinned at the vitest level, where OCG
// reference identity can be asserted directly). The fixture is enriched
// through the REAL CLI arms and read back through them — no mocks anywhere.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

let TMP = '';

function cliJson(args: string[]): unknown {
  const out = execFileSync(APP_EXE, args, { encoding: 'utf-8' });
  const lines = out.trim().split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
  return JSON.parse(lines.slice(start).join('\n'));
}

describe('catalog state survives committed page edits', () => {
  before(async () => {
    TMP = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-catalog-'));
    await waitForHarness();
  });

  after(() => {
    if (TMP && existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('bookmarks and page labels ride through a committed rotation', async () => {
    // Enrich a scratch copy through the real CLI: one bookmark to page 2 and
    // roman-numeral labels from page 1.
    const src = resolve(TMP, 'rich.pdf');
    copyFileSync(SAMPLE_PDF, src);
    const outlined = resolve(TMP, 'outlined.pdf');
    const outlineJson = resolve(TMP, 'outline.json');
    writeFileSync(
      outlineJson,
      JSON.stringify({ outline: [{ title: 'Catalog Carry Marker', page: 2, children: [] }] }),
    );
    execFileSync(APP_EXE, ['outline', src, '--from-json', outlineJson, '-o', outlined], {
      stdio: 'pipe',
    });
    const labeled = resolve(TMP, 'labeled.pdf');
    execFileSync(APP_EXE, ['page-labels', outlined, '-o', labeled, '--range', '1:r'], {
      stdio: 'pipe',
    });

    await openByPaths([labeled]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening the enriched file did not land on canvas',
    });
    const ids = await getWorkspacePageIds();
    await selectCanvasPages([ids[0]]);
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await commitPendingEdits();

    const dest = resolve(TMP, 'committed.pdf');
    await saveActiveAs(dest);

    // The bookmark survived, still pointing at page 2 — read back through
    // the same CLI arm that wrote it.
    const outline = cliJson(['outline', dest]) as {
      outline: { title: string; page: number }[];
    };
    expect(outline.outline.length).toBe(1);
    expect(outline.outline[0].title).toBe('Catalog Carry Marker');
    expect(outline.outline[0].page).toBe(2);

    // The label range survived (structure pinned semantically in vitest —
    // here the committed file must still carry the roman range at all).
    const bytes = readFileSync(dest);
    expect(bytes.includes('/PageLabels')).toBe(true);
  });

  for (const removeSelected of [false, true]) it(`preserves print/bookmark/Info identity, or refuses loss (remove selected=${removeSelected})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../catalog-metadata-live.local.d-'));
    const path = resolve(dir, 'source.pdf'), N = PDFName.of;
    const pdf = await PDFDocument.create({ updateMetadata: false });
    for (const width of [300, 400, 500]) pdf.addPage([width, 700]);
    pdf.catalog.set(N('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [2, 2], DisplayDocTitle: true }));
    const info = pdf.context.obj({ Title: PDFString.of('Own document'), Author: PDFString.of('Original author'),
      Private: PDFString.of('Private value'), CreationDate: PDFString.of('D:2020') });
    pdf.context.trailerInfo.Info = pdf.context.register(info);
    const root = pdf.context.obj({ Type: 'Outlines', Count: 1 }), rootRef = pdf.context.register(root);
    const item = pdf.context.obj({ Parent: rootRef, Title: PDFString.of('Preserved only, never opened'),
      A: { S: 'URI', URI: PDFString.of('https://example.invalid/manual') }, F: 2, C: [1, 0, 0] });
    const ref = pdf.context.register(item); root.set(N('First'), ref); root.set(N('Last'), ref); pdf.catalog.set(N('Outlines'), rootRef);
    const original = Buffer.from(await pdf.save()); writeFileSync(path, original);
    await closeAllFiles(); await openByPaths([path]);
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    const ids = await waitForActiveCanvasPageIds(); expect(ids).toHaveLength(3);
    await deleteCanvasPagesAndWait([ids[removeSelected ? 1 : 0]]);
    if (removeSelected) {
      let error = ''; try { await commitPendingEdits(); } catch (caught) { error = String(caught); }
      expect(error).toContain('commitPendingEdits failed'); expect(error).toContain('verif');
      expect(readFileSync(work).equals(before)).toBe(true);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 3);
    } else {
      await commitPendingEdits(); const saved = resolve(dir, 'saved.pdf'); await saveActiveAs(saved);
      const out = await PDFDocument.load(readFileSync(saved), { updateMetadata: false });
      const range = out.catalog.lookup(N('ViewerPreferences'), PDFDict).lookup(N('PrintPageRange'), PDFArray);
      expect(range.asArray().map(x => (x as PDFNumber).asNumber())).toEqual([1, 1]);
      expect(out.getPage(0).getWidth()).toBe(400);
      expect(out.getTitle()).toBe('Own document'); expect(out.getAuthor()).toBe('Original author');
      const carried = out.context.lookup(out.context.trailerInfo.Info!, PDFDict);
      expect(carried.lookup(N('Private'), PDFString).decodeText()).toBe('Private value');
      expect(carried.lookup(N('CreationDate'), PDFString).asString()).toBe('D:2020');
      const bookmark = out.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict);
      expect(bookmark.lookup(N('A'), PDFDict).lookup(N('URI'), PDFString).decodeText()).toBe('https://example.invalid/manual');
      expect(bookmark.lookup(N('F'), PDFNumber).asNumber()).toBe(2);
      expect(bookmark.lookup(N('C'), PDFArray).asArray().map(x => (x as PDFNumber).asNumber())).toEqual([1, 0, 0]);
    }
    expect(readFileSync(path).equals(original)).toBe(true);
  });
  for (const keepOwn of [true, false]) it(`keeps document language, preferences and dates with ${keepOwn ? 'one original page' : 'only imported pages'}`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../docs/audit/catalog-owner-live.local.d-'));
    const own = resolve(dir, 'own.pdf'), donor = resolve(dir, 'donor.pdf'), N = PDFName.of;
    for (const [path, language, count] of [[own, 'de-DE', 2], [donor, 'fr-FR', 1]] as const) {
      const pdf = await PDFDocument.create(); for (let i = 0; i < count; i++) pdf.addPage([600 + i * 10, 800]);
      pdf.catalog.set(N('Lang'), PDFString.of(language));
      pdf.catalog.set(N('ViewerPreferences'), pdf.context.obj({ DisplayDocTitle: path === own }));
      pdf.setCreationDate(new Date(path === own ? '2001-02-03T04:05:06Z' : '2011-01-01T00:00:00Z'));
      pdf.setModificationDate(new Date(path === own ? '2002-03-04T05:06:07Z' : '2012-01-01T00:00:00Z'));
      writeFileSync(path, await pdf.save());
    }
    await closeAllFiles(); await openByPaths([own]);
    const doc = (await getCanvasDocs())[0], originalIds = await getWorkspacePageIds();
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    await importPagesIntoDoc(donor, doc.id, 2); await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 3);
    await selectCanvasPages(keepOwn ? [originalIds[0]] : originalIds); await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === (keepOwn ? 2 : 1));
    await commitPendingEdits(); const out = await PDFDocument.load(readFileSync(work), { updateMetadata: false });
    expect(out.getPageCount()).toBe(keepOwn ? 2 : 1);
    expect(out.catalog.lookup(N('Lang'), PDFString).decodeText()).toBe('de-DE');
    expect(out.catalog.lookup(N('ViewerPreferences'), PDFDict).lookup(N('DisplayDocTitle'), PDFBool).asBoolean()).toBe(true);
    expect(out.getCreationDate()?.toISOString()).toBe('2001-02-03T04:05:06.000Z');
    expect(out.getModificationDate()?.toISOString()).toBe('2002-03-04T05:06:07.000Z');
    expect(readFileSync(own).equals(before)).toBe(true);
  });
});
