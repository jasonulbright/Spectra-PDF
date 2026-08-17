import { resolve } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
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
  batchOcrSetFolders,
  batchOcrSetFiling,
  batchOcrStart,
  batchOcrSnapshot,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Batch OCR folder mirror:
// fixture tree {a/scan.pdf (committed image-only fixture), born.pdf
// (generated born-digital), broken.pdf (garbage bytes)} → run the dialog's
// real flow with injected folders → assert the mirror: scanned output
// extractable by an independent reader, born-digital byte-identical,
// broken reported skipped, run completed. Recognition is the REAL bundled
// native Tesseract via the engine (14-ocr-find precedent; tesseract.js is
// retired — the GUI, CLI and scheduled runs share one recognizer).

const SCANNED = resolve(__dirname, '..', 'fixtures', 'scanned.pdf');

async function extractAllText(path: string): Promise<string> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
  }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) if ('str' in item) out += item.str + ' ';
  }
  await pdf.loadingTask.destroy();
  return out;
}

describe('batch OCR folder mirror', () => {
  let tmp: string;
  let src: string;
  let dest: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-batch-ocr-'));
    src = resolve(tmp, 'source');
    dest = resolve(tmp, 'mirror');
    mkdirSync(resolve(src, 'a'), { recursive: true });
    // Scanned page in a SUBFOLDER — proves the mirror recreates structure.
    copyFileSync(SCANNED, resolve(src, 'a', 'scan.pdf'));
    // Born-digital sibling at the root.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText('Born digital text', { x: 40, y: 200, size: 14, font });
    writeFileSync(resolve(src, 'born.pdf'), await doc.save());
    // Garbage wearing a .pdf extension.
    writeFileSync(resolve(src, 'broken.pdf'), 'not a pdf at all');
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  // Each test dismisses the dialog on its LAST line, so a test that fails
  // earlier leaves it standing — and a standing dialog showing a finished run's
  // report has none of the form controls the next test opens it to drive. That
  // turns one real failure into a run of "element not displayed" failures that
  // name the wrong surface. Cleanup here so a failure stays one failure.
  afterEach(async () => {
    const dialog = $('[data-testid="batch-ocr-dialog"]');
    if (!(await dialog.isExisting())) return;
    for (const id of ['batch-ocr-close', 'batch-ocr-cancel']) {
      const button = $(`[data-testid="${id}"]`);
      if (!(await button.isExisting())) continue;
      await button.click().catch(() => {});
      break;
    }
    await dialog.waitForExist({ reverse: true, timeout: 10_000 }).catch(() => {});
  });

  it('mirrors a folder: OCRs the scanned file, copies the born-digital one, reports the broken one', async function () {
    this.timeout(240_000); // real in-webview OCR (first run loads core+lang)
    await waitForHarness();

    // Open the dialog through its registered command (the menu's entry).
    const enabled = await invokeAppCommand('tools.batchOcr');
    expect(enabled).toBe(true);
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });

    // Inject folders through the dialog's real selection flow; enumeration
    // runs on selectSource, so the count appears once scanning finishes.
    await batchOcrSetFolders(src, dest);
    await browser.waitUntil(
      async () => (await batchOcrSnapshot())?.fileCount === 3,
      { timeout: 15_000, timeoutMsg: 'enumeration never found the 3 fixture PDFs' },
    );

    await batchOcrStart();
    await browser.waitUntil(
      async () => (await batchOcrSnapshot())?.phase === 'done',
      {
        timeout: 200_000,
        interval: 1_000,
        timeoutMsg: 'batch run never reached done — snapshot: ' + JSON.stringify(await batchOcrSnapshot()),
      },
    );

    const snapshot = await batchOcrSnapshot();
    const report = snapshot?.report;
    expect(report).toBeTruthy();
    expect(report!.cancelled).toBe(false);
    const byRel = new Map(report!.results.map((r) => [r.rel, r]));
    // Status AND reason: every way this entry can miss lands on `skipped` with
    // the cause in `reason` (a load classification, or whatever recognition
    // threw). Asserting the status alone throws that cause away and leaves
    // "expected ocr, received skipped" as the whole record of the failure.
    // A passing `ocr` can carry a reason of its own (pages with no recognizable
    // text), so only a MISS spends the reason on the failure text.
    const scan = byRel.get('a\\scan.pdf');
    expect(scan?.status === 'ocr' ? 'ocr' : `${scan?.status} — ${scan?.reason ?? ''}`).toBe('ocr');
    expect(byRel.get('born.pdf')?.status).toBe('copied');
    expect(byRel.get('broken.pdf')?.status).toBe('skipped');

    // The mirror on disk: structure recreated; born-digital byte-identical;
    // broken absent; scanned output independently extractable (the same
    // acceptance bar as the OCR layer: genuinely searchable ON DISK).
    const mirroredScan = resolve(dest, 'a', 'scan.pdf');
    const mirroredBorn = resolve(dest, 'born.pdf');
    expect(existsSync(mirroredScan)).toBe(true);
    expect(existsSync(mirroredBorn)).toBe(true);
    expect(existsSync(resolve(dest, 'broken.pdf'))).toBe(false);
    expect(readFileSync(mirroredBorn).equals(readFileSync(resolve(src, 'born.pdf')))).toBe(true);
    const text = (await extractAllText(mirroredScan)).toUpperCase();
    expect(text).toContain('INVOICE');
    // Sources untouched: the original scanned file still has no text layer.
    const originalText = (await extractAllText(resolve(src, 'a', 'scan.pdf'))).trim();
    expect(originalText).toBe('');

    // The run leaves a durable record. The dialog's report
    // dies with the dialog — this is the artefact that survives it, and the
    // only thing a scheduled run will ever leave behind, so the assertion is
    // on the FILE's contents, not on the on-screen path label.
    const logPath = snapshot?.logPath;
    expect(logPath).toBeTruthy();
    expect(existsSync(logPath!)).toBe(true);
    expect(logPath!).toMatch(/batch-ocr-\d{4}-\d{2}-\d{2}_\d{6}\.log$/);
    const log = readFileSync(logPath!, 'utf8');
    expect(log).toContain('Spectra PDF — Batch OCR log');
    expect(log).toContain(src);
    expect(log).toContain(dest);
    expect(log).toContain('Result:       completed');
    expect(log).toContain('Files: 3 processed');
    // One greppable line per file, status first — what the format exists for.
    expect(log).toMatch(/\[ocr\] +a\\scan\.pdf — \d+ pages? made searchable/);
    expect(log).toContain('[copied]  born.pdf');
    expect(log).toMatch(/\[skipped\] broken\.pdf — /);
    await $('[data-testid="batch-ocr-log-path"]').waitForDisplayed({ timeout: 5_000 });

    await $('[data-testid="batch-ocr-close"]').click();
  });

  it('refuses a destination inside the source folder', async () => {
    await waitForHarness();
    await invokeAppCommand('tools.batchOcr');
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await batchOcrSetFolders(src, resolve(src, 'nested-out'));
    await $('[data-testid="batch-ocr-conflict"]').waitForDisplayed({ timeout: 10_000 });
    const startBtn = $('[data-testid="batch-ocr-start"]');
    expect(await startBtn.isEnabled()).toBe(false);

    await $('[data-testid="batch-ocr-cancel"]').click();
  });

  // The only batch behaviour that MOVES the user's
  // own files, so this drives it against a REAL tree and asserts the source
  // folder afterwards, not just the report.
  //
  // Its own fixture tree, deliberately: the test consumes its source folder, so
  // sharing `src` with the tests above would make them order-dependent. No
  // scanned page either — the moved/error split and the verify-before-move gate
  // are what is under test, and test 1 already covers real recognition.
  it('files originals into moved/error folders, verified first, structure preserved', async function () {
    this.timeout(120_000);
    const tree = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-batch-filing-'));
    const fSrc = resolve(tree, 'in');
    const fDest = resolve(tree, 'out');
    const fMoved = resolve(tree, 'done');
    const fErrors = resolve(tree, 'failed');
    mkdirSync(resolve(fSrc, 'nested'), { recursive: true });
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText('Already searchable', { x: 40, y: 200, size: 14, font });
    writeFileSync(resolve(fSrc, 'nested', 'good.pdf'), await doc.save());
    writeFileSync(resolve(fSrc, 'rubbish.pdf'), 'not a pdf at all');

    await waitForHarness();
    expect(await invokeAppCommand('tools.batchOcr')).toBe(true);
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await batchOcrSetFolders(fSrc, fDest);
    await browser.waitUntil(async () => (await batchOcrSnapshot())?.fileCount === 2, {
      timeout: 15_000,
      timeoutMsg: 'enumeration never found the 2 filing fixtures',
    });

    // The options live behind a collapsed disclosure — everything in it moves
    // the user's files, so it is deliberately not the first thing you see.
    await $('[data-testid="batch-ocr-filing"] summary').click();
    // Repair is a real checkbox the user clicks; the roots come through the
    // harness because their pickers are native.
    const repairBox = $('[data-testid="batch-ocr-repair"]');
    await repairBox.waitForDisplayed({ timeout: 5_000 });
    expect(await repairBox.isSelected()).toBe(false); // OFF by default
    await repairBox.click();
    await batchOcrSetFiling({ movedRoot: fMoved, errorRoot: fErrors });
    await $('[data-testid="batch-ocr-moved"]').waitForDisplayed({ timeout: 5_000 });

    await batchOcrStart();
    await browser.waitUntil(async () => (await batchOcrSnapshot())?.phase === 'done', {
      timeout: 100_000,
      interval: 500,
      timeoutMsg:
        'filing run never reached done — snapshot: ' + JSON.stringify(await batchOcrSnapshot()),
    });

    const results = (await batchOcrSnapshot())!.report!.results;
    const byRel = new Map(results.map((r) => [r.rel, r]));
    const good = byRel.get('nested\\good.pdf')!;
    const bad = byRel.get('rubbish.pdf')!;
    expect(good.status).toBe('copied');
    expect(bad.status).toBe('skipped');

    // ON DISK is the assertion that matters: the searchable copy is in the
    // destination, the original is under the moved tree at the SAME relative
    // path, the failure is under the error tree, and the source folder no
    // longer holds either.
    expect(existsSync(resolve(fDest, 'nested', 'good.pdf'))).toBe(true);
    expect(existsSync(resolve(fMoved, 'nested', 'good.pdf'))).toBe(true);
    expect(existsSync(resolve(fErrors, 'rubbish.pdf'))).toBe(true);
    expect(existsSync(resolve(fSrc, 'nested', 'good.pdf'))).toBe(false);
    expect(existsSync(resolve(fSrc, 'rubbish.pdf'))).toBe(false);
    expect(good.movedTo).toBe(resolve(fMoved, 'nested', 'good.pdf'));
    expect(bad.movedTo).toBe(resolve(fErrors, 'rubbish.pdf'));
    expect(results.some((r) => r.moveError)).toBe(false);

    // Auto-repair really ran end to end: `rubbish.pdf` is not a PDF at all, so
    // the honest outcome is that repair was ATTEMPTED and did not help. That
    // string only exists if the scratch allocation and the engine `repair`
    // call both happened — the wiring this leg is here to prove.
    expect(bad.reason).toContain('repair did not help');

    const log = readFileSync((await batchOcrSnapshot())!.logPath!, 'utf8');
    expect(log).toContain(`processed originals -> ${fMoved}`);
    expect(log).toContain(`failed originals -> ${fErrors}`);
    expect(log).toContain('repair damaged files');
    expect(log).toContain(`-> original moved to ${resolve(fMoved, 'nested', 'good.pdf')}`);
    expect(log).toContain('Originals: 2 moved · 0 NOT moved');

    await $('[data-testid="batch-ocr-close"]').click();
    rmSync(tree, { recursive: true, force: true });
  });

  // A folder mixing English and French should not need two
  // passes. Several languages are recognized TOGETHER (Tesseract loads each
  // model); this pins that the picker actually holds a set rather than
  // behaving like the single-select it replaced.
  it('accepts several recognition languages at once', async () => {
    await waitForHarness();
    await invokeAppCommand('tools.batchOcr');
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });

    const eng = $('[data-testid="batch-ocr-lang-eng"]');
    const fra = $('[data-testid="batch-ocr-lang-fra"]');
    await eng.waitForDisplayed({ timeout: 10_000 });
    expect(await eng.isSelected()).toBe(true); // English is the default

    await fra.click();
    await browser.waitUntil(async () => await fra.isSelected(), {
      timeout: 5_000,
      timeoutMsg: 'selecting a second language did not take',
    });
    // The first one is STILL selected — the failure this guards against is a
    // picker that silently behaves like a radio group.
    expect(await eng.isSelected()).toBe(true);

    // The honesty note only appears once more than one is chosen: multi is
    // slower and not auto-detection, and the UI has to say so.
    await expect($('[data-testid="batch-ocr-lang-note"]')).toBeDisplayed();

    await fra.click(); // leave the shared workspace as we found it
    await browser.waitUntil(async () => !(await fra.isSelected()), { timeout: 5_000 });
    await $('[data-testid="batch-ocr-cancel"]').click();
  });

  // Named presets. The assertion that matters is that recalling one restores
  // the settings ACROSS A CLOSE — the whole complaint was that fourteen
  // settings had to be retyped every run — and that the source is re-listed
  // rather than restored from a stored count.
  it('saves the dialog’s settings under a name and recalls them after a close', async () => {
    await waitForHarness();
    await invokeAppCommand('tools.batchOcr');
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await batchOcrSetFolders(src, dest);
    await browser.waitUntil(async () => (await batchOcrSnapshot())?.fileCount === 3, {
      timeout: 15_000,
      timeoutMsg: 'enumeration never found the 3 fixture PDFs',
    });

    // Two settings that are OFF by default and live in different sections.
    const enhance = $('[data-testid="batch-enhance"]');
    await enhance.waitForDisplayed({ timeout: 5_000 });
    expect(await enhance.isSelected()).toBe(false);
    await enhance.click();
    await $('[data-testid="batch-enhance-orientation"]').waitForDisplayed({ timeout: 5_000 });
    await $('[data-testid="batch-enhance-orientation"]').click(); // orientation OFF
    await $('[data-testid="batch-ocr-filing"] summary').click();
    const repair = $('[data-testid="batch-ocr-repair"]');
    await repair.waitForDisplayed({ timeout: 5_000 });
    await repair.click();

    const name = $('[data-testid="batch-ocr-preset-name"]');
    await name.setValue('E2E nightly');
    await $('[data-testid="batch-ocr-preset-save"]').click();
    // The saved preset is selected, which is what makes Rename and Delete
    // reachable — a save that left nothing selected would strand it.
    await $('[data-testid="batch-ocr-preset-rename"]').waitForDisplayed({ timeout: 5_000 });

    await $('[data-testid="batch-ocr-cancel"]').click();
    await $('[data-testid="batch-ocr-dialog"]').waitForExist({ reverse: true, timeout: 10_000 });

    // Reopened: every control is back at its default until the preset is
    // recalled, which is the state the complaint was about.
    await invokeAppCommand('tools.batchOcr');
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="batch-enhance"]').isSelected()).toBe(false);

    await $('[data-testid="batch-ocr-preset-select"]').selectByVisibleText('E2E nightly');
    await browser.waitUntil(async () => await $('[data-testid="batch-enhance"]').isSelected(), {
      timeout: 10_000,
      timeoutMsg: 'recalling the preset did not restore the enhancement switch',
    });
    expect(await $('[data-testid="batch-enhance-orientation"]').isSelected()).toBe(false);
    await $('[data-testid="batch-ocr-filing"] summary').click();
    expect(await $('[data-testid="batch-ocr-repair"]').isSelected()).toBe(true);
    // The folders came back AND the tree was walked again, so Start is armed
    // against a listing rather than against a remembered number.
    expect(await $('[data-testid="batch-ocr-source"]').getText()).toBe(src);
    expect(await $('[data-testid="batch-ocr-dest"]').getText()).toBe(dest);
    await browser.waitUntil(async () => (await batchOcrSnapshot())?.fileCount === 3, {
      timeout: 15_000,
      timeoutMsg: 'recalling the preset did not re-list the source folder',
    });

    // Delete takes a confirm, then the preset is gone from the list — leaving
    // the shared workspace as this test found it.
    await $('[data-testid="batch-ocr-preset-delete"]').click();
    await $('[data-testid="batch-ocr-preset-delete-confirm"]').click();
    await browser.waitUntil(
      async () =>
        !(await $('[data-testid="batch-ocr-preset-select"]').getText()).includes('E2E nightly'),
      { timeout: 5_000, timeoutMsg: 'the deleted preset is still listed' },
    );

    await $('[data-testid="batch-ocr-cancel"]').click();
  });
});
