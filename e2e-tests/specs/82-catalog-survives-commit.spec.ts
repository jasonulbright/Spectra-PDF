import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFBool, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
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
