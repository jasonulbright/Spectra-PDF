import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { waitForHarness, getState, invokeAppCommand } from '../support/harness.js';

// Phase 8 — Create PDF from PostScript (Distill) against the real binary:
// the File-menu dialog opens, the harness injects paths (native pickers
// are undrivable), the REAL engine converts via the bundled Ghostscript,
// the output is independently validated Node-side with pdf.js, and the
// dialog's Open action routes the result through the normal open funnel.

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const PS_FIXTURE = `%!PS-Adobe-3.0
%%Pages: 1
%%Page: 1 1
/Helvetica findfont 24 scalefont setfont
72 700 moveto
(Distilled end to end) show
showpage
%%EOF
`;

async function createPdfRun(source: string, output: string): Promise<boolean> {
  return browser.executeAsync<boolean, [string, string]>(
    function (src, out, done) {
      (window as any).__SPECTRA_TEST__.createPdfRun(src, out)
        .then((ok: boolean) => done(ok))
        .catch(() => done(false));
    },
    source,
    output,
  );
}

describe('create PDF from PostScript (Phase 8)', () => {
  let tmp: string;
  let psPath: string;
  let outPath: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-distill-'));
    psPath = resolve(tmp, 'source.ps');
    outPath = resolve(tmp, 'distilled.pdf');
    writeFileSync(psPath, PS_FIXTURE);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('distills a .ps through the dialog and the result opens in the app', async function () {
    this.timeout(120_000);
    await waitForHarness();

    // Open the dialog via its real command (menu path integrity is
    // covered by the menus vitest; this exercises the command→dialog
    // wiring).
    expect(await invokeAppCommand('file.createPdfFromPostScript')).toBe(true);
    await $('[data-testid="create-pdf-dialog"]').waitForDisplayed({ timeout: 10_000 });

    // REAL conversion, injected paths.
    expect(await createPdfRun(psPath, outPath)).toBe(true);
    await $('[data-testid="create-pdf-done"]').waitForDisplayed({ timeout: 15_000 });

    // Node-side independent validation: the output is a real 1-page PDF.
    expect(existsSync(outPath)).toBe(true);
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(outPath)),
      isEvalSupported: false,
    }).promise;
    expect(pdf.numPages).toBe(1);
    await pdf.loadingTask.destroy();

    // The Open action routes through the normal funnel.
    await $('[data-testid="create-pdf-open"]').click();
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('distilled.pdf'),
      { timeout: 15_000, timeoutMsg: 'distilled PDF never opened in the app' },
    );
  });
});
