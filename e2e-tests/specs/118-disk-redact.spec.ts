// Search & Redact across a FOLDER: files nobody opened, swept by path, with
// the checkbox still deciding which occurrences go.
//
// 113-search-redact covers the open-document scope and 40-batch-ocr covers the
// folder mirror; neither joins them. The three assertions that matter here are
// the ones only this spec can make: the ORIGINALS are byte-identical
// afterwards, the MIRROR carries the redaction, and an unchecked occurrence of
// the same term — in the same mirrored file — is still readable.
import { resolve } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  invokeAppCommand,
  diskRedactSetFolders,
  diskRedactSearch,
  diskRedactCheck,
  diskRedactApply,
  diskRedactSnapshot,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const TERM = 'Jane Roe';

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = (await page.getTextContent()) as { items: { str?: string }[] };
    texts.push(content.items.map((it) => it.str ?? '').join(''));
  }
  await pdf.loadingTask.destroy();
  return texts;
}

/** Two pages carrying the term, each with neighbouring words, so "the
 * redaction took the line" stays distinguishable from "it took the words". */
async function makeDoc(path: string, pages: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    doc.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 18, font });
  }
  writeFileSync(path, await doc.save());
}

describe('Search & Redact across a folder', () => {
  let tmp: string;
  let src: string;
  let dest: string;
  let alpha: string;
  let beta: string;
  let clean: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-f18-'));
    src = resolve(tmp, 'source');
    dest = resolve(tmp, 'mirror');
    mkdirSync(resolve(src, 'sub'), { recursive: true });
    alpha = resolve(src, 'alpha.pdf');
    beta = resolve(src, 'sub', 'beta.pdf');
    clean = resolve(src, 'clean.pdf');
    await makeDoc(alpha, [
      `CONFIDENTIAL ${TERM} report`,
      `Second mention of ${TERM} here`,
    ]);
    await makeDoc(beta, [`Contact ${TERM} at once`]);
    await makeDoc(clean, ['Nothing sensitive on this page']);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('sweeps a folder by path, redacts only the checked hits, and never touches the originals', async function () {
    this.timeout(180_000);
    await waitForHarness();

    // No document is open, and none is opened by any of this — the command is
    // enabled regardless, like the other folder tools.
    expect(await invokeAppCommand('tools.diskRedact')).toBe(true);
    await $('[data-testid="disk-redact-dialog"]').waitForDisplayed({ timeout: 10_000 });

    const before = {
      alpha: readFileSync(alpha),
      beta: readFileSync(beta),
      clean: readFileSync(clean),
    };

    await diskRedactSetFolders(src, dest);
    await browser.waitUntil(async () => (await diskRedactSnapshot())?.fileCount === 3, {
      timeout: 20_000,
      timeoutMsg: 'enumeration never found the 3 fixture PDFs',
    });

    await diskRedactSearch(TERM);
    await browser.waitUntil(async () => (await diskRedactSnapshot())?.phase === 'review', {
      timeout: 120_000,
      interval: 500,
      timeoutMsg:
        'the sweep never reached review — snapshot: ' +
        JSON.stringify(await diskRedactSnapshot()),
    });

    const reviewed = await diskRedactSnapshot();
    const byRel = new Map((reviewed?.files ?? []).map((f) => [f.rel, f]));
    expect(byRel.get('alpha.pdf')?.hits).toBe(2);
    expect(byRel.get('sub\\beta.pdf')?.hits).toBe(1);
    expect(byRel.get('clean.pdf')?.hits).toBe(0);
    // Three hits are offered and NONE is checked: the run pre-consents to
    // nothing.
    expect(reviewed?.hitKeys).toHaveLength(3);

    // Check a subset across two files — alpha page 1 and beta page 1 —
    // deliberately leaving alpha page 2 alone.
    const checked = (reviewed?.hitKeys ?? []).filter((key) => !key.endsWith(' 2 1'));
    expect(checked).toHaveLength(2);
    await diskRedactCheck(checked);

    await diskRedactApply();
    await browser.waitUntil(async () => (await diskRedactSnapshot())?.phase === 'done', {
      timeout: 120_000,
      interval: 500,
      timeoutMsg:
        'the apply never finished — snapshot: ' + JSON.stringify(await diskRedactSnapshot()),
    });

    const report = (await diskRedactSnapshot())?.report;
    expect(report?.cancelled).toBe(false);
    const results = new Map((report?.results ?? []).map((r) => [r.rel, r]));
    expect(results.get('alpha.pdf')?.status).toBe('redacted');
    expect(results.get('sub\\beta.pdf')?.status).toBe('redacted');
    // A file with no hits still lands in the mirror: the output is a copy of
    // the tree, not a scatter of the files that happened to match.
    expect(results.get('clean.pdf')?.status).toBe('copied');

    // The ORIGINALS are untouched, byte for byte.
    expect(readFileSync(alpha).equals(before.alpha)).toBe(true);
    expect(readFileSync(beta).equals(before.beta)).toBe(true);
    expect(readFileSync(clean).equals(before.clean)).toBe(true);

    const mirrorAlpha = resolve(dest, 'alpha.pdf');
    const mirrorBeta = resolve(dest, 'sub', 'beta.pdf');
    expect(existsSync(mirrorAlpha)).toBe(true);
    expect(existsSync(mirrorBeta)).toBe(true);
    expect(existsSync(resolve(dest, 'clean.pdf'))).toBe(true);

    const textsAlpha = await pageTexts(mirrorAlpha);
    const textsBeta = await pageTexts(mirrorBeta);

    // The checked occurrences are gone from the MIRROR…
    expect(textsAlpha[0]).not.toContain(TERM);
    expect(textsBeta[0]).not.toContain(TERM);
    // …their neighbours on the same line survived, which is what proves the
    // removal was per-glyph rather than "drop the whole show operator"…
    expect(textsAlpha[0]).toContain('CONFIDENTIAL');
    expect(textsAlpha[0]).toContain('report');
    expect(textsBeta[0]).toContain('Contact');
    expect(textsBeta[0]).toContain('at once');
    // …and the UNCHECKED occurrence is still there. This is the assertion that
    // proves the checkbox means something across a whole folder.
    expect(textsAlpha[1]).toContain(TERM);
  });
});
