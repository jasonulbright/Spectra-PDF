import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  getState,
  invokeAppCommand,
  waitForDisplayedSelector,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

// A cut-off HEIC picture through the REAL dialogs and the REAL engine: it is
// still imported, and the dialog that imported it says that it is cut off. A
// whole picture gets no message.

const FIXTURES = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'heif');
const SENTENCE = 'the file is cut off. Parts of the picture can be missing or wrong.';

interface RunResult {
  output: string;
  pages: number;
}

async function harnessRun(
  name: 'createPdfRun' | 'combineRun',
  sources: string[],
  output: string,
  options?: Record<string, unknown>,
): Promise<RunResult | null> {
  return browser.executeAsync<RunResult | null, [string, string[], string, unknown]>(
    function (fn, srcs, out, opts, done) {
      (window as any).__SPECTRA_TEST__[fn](srcs, out, opts ?? undefined)
        .then((r: RunResult | null) => done(r))
        .catch(() => done(null));
    },
    name,
    sources,
    output,
    options ?? null,
  );
}

async function texts(testId: string): Promise<string[]> {
  const found: string[] = [];
  for (const element of await $$(`[data-testid="${testId}"]`)) found.push(await element.getText());
  return found;
}

async function openDialog(command: string, testId: string): Promise<void> {
  expect(await invokeAppCommand(command)).toBe(true);
  await $(`[data-testid="${testId}"]`).waitForDisplayed({ timeout: 10_000 });
}

async function closeDialog(testId: string): Promise<void> {
  await browser.keys('Escape');
  await waitForDisplayedSelector(`[data-testid="${testId}"]`, { reverse: true, timeout: 10_000 });
}

describe('a cut-off HEIC picture', () => {
  let tmp: string;
  let cut: string;
  let whole: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-cutoff-'));
    const data = readFileSync(resolve(FIXTURES, 'grid-tiled.heic'));
    cut = resolve(tmp, 'holiday-cut.heic');
    writeFileSync(cut, data.subarray(0, Math.floor(data.length * 0.6)));
    whole = resolve(FIXTURES, 'rgb8.heic');
  });

  after(async () => {
    await browser.execute(() => localStorage.removeItem('guided-actions'));
    await invokeAppCommand('tools.close');
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('is imported by Create PDF, which names it and its page', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openDialog('file.createPdf', 'create-pdf-dialog');

    const out = resolve(tmp, 'created.pdf');
    const result = await harnessRun('createPdfRun', [whole, cut], out);
    expect(result?.pages).toBe(2);
    expect(existsSync(out)).toBe(true);
    await $('[data-testid="create-pdf-cut-off"]').waitForDisplayed({ timeout: 30_000 });
    expect(await texts('create-pdf-cut-off')).toEqual([`holiday-cut.heic (PDF pages: 2): ${SENTENCE}`]);
    if (process.env.SPECTRA_CUTOFF_SHOT) await browser.saveScreenshot(process.env.SPECTRA_CUTOFF_SHOT);

    // A later run of whole pictures drops the message.
    expect((await harnessRun('createPdfRun', [whole], resolve(tmp, 'whole.pdf')))?.pages).toBe(1);
    await waitForDisplayedSelector('[data-testid="create-pdf-cut-off"]', { reverse: true, timeout: 30_000 });
    await closeDialog('create-pdf-dialog');
  });

  it('is named by Combine into a new file', async function () {
    this.timeout(120_000);
    await openDialog('document.combineFiles', 'combine-dialog');
    const result = await harnessRun('combineRun', [cut, whole], resolve(tmp, 'combined.pdf'), { target: 'new' });
    expect(result?.pages).toBe(2);
    await $('[data-testid="combine-cut-off"]').waitForDisplayed({ timeout: 30_000 });
    expect(await texts('combine-cut-off')).toEqual([`holiday-cut.heic (PDF pages: 1): ${SENTENCE}`]);

    // The result opens through the funnel, and gives the append run a destination.
    await $('[data-testid="combine-open"]').click();
    await browser.waitUntil(async () => ((await getState()).activeFile?.path ?? '').includes('combined.pdf'), {
      timeout: 20_000,
      timeoutMsg: 'the combined PDF never opened',
    });
    await waitForDisplayedSelector('[data-testid="combine-dialog"]', { reverse: true, timeout: 20_000 });
  });

  it('is named by Combine into the open document', async function () {
    this.timeout(120_000);
    await openDialog('document.combineFiles', 'combine-dialog');
    const result = await harnessRun('combineRun', [cut], '', { target: 'append' });
    expect(result?.pages).toBe(1);
    await $('[data-testid="combine-appended-cut-off"]').waitForDisplayed({ timeout: 30_000 });
    expect(await texts('combine-appended-cut-off')).toEqual([`holiday-cut.heic: ${SENTENCE}`]);
    await closeDialog('combine-dialog');
  });

  it('is named by a guided watermark step, on the open document and over a folder', async function () {
    this.timeout(180_000);
    expect(await invokeAppCommand('tools.open.actions')).toBe(true);
    await $('[data-testid="action-new"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="action-new"]').click();
    await setReactInputValue('[data-testid="action-name"]', 'Stamp picture');
    await setReactSelectValue('[data-testid="action-add-op"]', 'watermark');
    await $('[data-testid="action-add-step"]').click();
    await $('[data-testid="action-step-0-image"]').waitForDisplayed();
    await setReactInputValue('[data-testid="action-step-0-image"]', cut);
    await $('[data-testid="action-save"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();
    const stored = (await browser.execute(() =>
      JSON.parse(localStorage.getItem('guided-actions') ?? '[]'),
    )) as { id: string; name: string }[];
    const action = stored.find((a) => a.name === 'Stamp picture')!;

    await $(`[data-testid="action-run-${action.id}"]`).click();
    await $('[data-testid="run-done"]').waitForDisplayed({ timeout: 60_000 });
    expect(await texts('actions-run-cut-off')).toEqual([`holiday-cut.heic: ${SENTENCE}`]);
    await $('[data-testid="run-close"]').click();

    // Two documents take the same picture; the run names it one time.
    const source = resolve(tmp, 'in');
    mkdirSync(source);
    for (const name of ['a.pdf', 'b.pdf']) copyFileSync(resolve(tmp, 'whole.pdf'), resolve(source, name));
    const error = (await browser.executeAsync(
      function (id: string, src: string, dst: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .guidedRunFolder(id, {}, src, dst)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      action.id,
      source,
      resolve(tmp, 'stamped'),
    )) as string | null;
    expect(error).toBeNull();
    await $('[data-testid="folderrun-cut-off"]').waitForDisplayed({ timeout: 60_000 });
    expect(await texts('folderrun-cut-off')).toEqual([`holiday-cut.heic: ${SENTENCE}`]);
  });
});
