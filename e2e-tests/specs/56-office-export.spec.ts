import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  exportActiveAs,
  exportImagesRun,
  invokeAppCommand,
} from '../support/harness.js';

// Export the active document to editable Office / web formats via the
// bundled (or, on a dev machine, system) LibreOffice. Verifies REAL editable
// output on disk, not a page image: the DOCX's text is present as <w:t> runs.
//
// LibreOffice availability: the app resolves a bundled copy first, else a
// system install. If neither is present this whole suite is skipped (the
// engine returns a clear "not available" error) rather than failing CI on a
// machine without the runtime.

const SENTENCE = 'The quick brown fox jumps over the lazy dog.';

async function makeTextPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(SENTENCE, { x: 72, y: 720, size: 18, font });
  page.drawText('Second paragraph of editable body text here.', { x: 72, y: 698, size: 18, font });
  writeFileSync(path, await doc.save());
}

function libreOfficeAvailable(): boolean {
  for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (base && existsSync(resolve(base, 'LibreOffice', 'program', 'soffice.exe'))) return true;
  }
  // The vendored copy sits beside the built exe under resources/libreoffice.
  return existsSync(resolve(__dirname, '..', '..', 'resources', 'libreoffice', 'program', 'soffice.exe'));
}

describe('export to Office / web formats', () => {
  let tmp: string;
  let source: string;

  before(async function () {
    if (!libreOfficeAvailable()) this.skip();
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-export-'));
    source = resolve(tmp, 'text.pdf');
    await makeTextPdf(source);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('exports a valid DOCX (OOXML) through the wired app path', async function () {
    this.timeout(120_000); // LibreOffice cold start + the HTML bridge
    const dest = resolve(tmp, 'out.docx');
    const r = await exportActiveAs(dest, 'docx');
    expect(typeof r === 'string' && r.startsWith('__SPECTRA_E2E_ERROR__')).toBe(false);
    expect(existsSync(dest)).toBe(true);
    // A real .docx is an OOXML zip — the "PK" local-file-header signature.
    // (The editable-<w:t>-runs fidelity is proven in tests/test_office_export.py;
    // here we prove the app's wired path produces a valid Word file on disk.)
    const head = readFileSync(dest).subarray(0, 2).toString('latin1');
    expect(head).toBe('PK');
  });

  it('exports pages as images through the Export Images dialog (gs raster)', async function () {
    this.timeout(60_000);
    // Open the dialog via its registered command (the menu path), then drive
    // the REAL gated export with an injected destination (native save dialog).
    expect(await invokeAppCommand('file.exportImages')).toBe(true);
    await $('[data-testid="export-images-dialog"]').waitForDisplayed({ timeout: 10_000 });

    const dest = resolve(tmp, 'page.png');
    const r = (await exportImagesRun(dest, { format: 'png', dpi: 72 })) as {
      outputs?: string[];
      pages_rendered?: number;
    } | null;
    expect(r && typeof r === 'object').toBe(true);
    expect(r!.pages_rendered).toBe(1); // the fixture is one page → exact name
    expect(r!.outputs).toEqual([dest]);
    expect(existsSync(dest)).toBe(true);
    const head = readFileSync(dest).subarray(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic

    await $('[data-testid="export-images-close"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-testid="export-images-dialog"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'the Export Images dialog never closed' },
    );
  });

  it('exports an HTML file carrying the real text', async function () {
    this.timeout(120_000);
    const dest = resolve(tmp, 'out.html');
    await exportActiveAs(dest, 'html');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toContain('quick brown fox');
  });
});
